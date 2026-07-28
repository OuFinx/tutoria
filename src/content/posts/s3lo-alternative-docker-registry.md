---
title: 'How I Built an Alternative to Docker Registries Using Just an S3 Bucket'
description: 'A pet project that turned into a working ECR replacement. Push Docker images to an S3 bucket, pull them fast, sign them, and run them in Kubernetes.'
author: 'OuFinx'
pubDate: '2026-04-18'
updatedDate: '2026-07-28'
heroImage: '../../assets/s3lo/s3lo-hero.png'
tags: ['Kubernetes', 'AWS', 'Docker', 'S3', 'DevOps']
---

## Introduction

Ordinary working day. I pushed a deployment to EKS, went for coffee, came back, and the pod was still sitting in `ContainerCreating`. Image around 2 GB. ECR was taking its sweet time.

Fine, happens. Except it happened again the next deploy. And the one after that.

So I started digging, and somewhere along the way I found an article where someone had tested keeping Docker images directly on S3. The pull numbers were kind of ridiculous, up to 100 Gbps on EC2, because that is just what S3 gives you inside AWS. Storage was roughly a quarter of the ECR price too.

My first thought was that surely a tool for this already exists. It did not. Or at least I could not find one 😁

So I built it.

## Why registries were annoying me

ECR, Docker Hub, GHCR are fine. I am not here to tell you they are bad. But if you sit inside AWS and pull big images all day, the small annoyances stack up:

| | ECR / Docker Hub | s3lo |
|---|---|---|
| **Pull speed** | ~1-5 Gbps | up to 100 Gbps on EC2 |
| **Storage cost** | $0.10/GB/month | $0.023/GB/month (S3 Standard) |
| **Cloud support** | vendor-specific | S3, GCS, Azure Blob, MinIO, R2, Ceph |
| **Registry to manage** | yes | it is a bucket |

The speed thing is not magic. EC2 and EKS nodes talk to S3 over AWS internal network, and a registry endpoint sitting behind a load balancer simply cannot compete with that.

The part I underrated at first was the simplicity. Nothing to provision. No registry to keep alive. A bucket and an IAM policy, done.

## So what is s3lo

A CLI written in Go. It pushes and pulls Docker images to anything S3-compatible: AWS S3, Google Cloud Storage, Azure Blob, MinIO, Cloudflare R2, Ceph, or a folder on your laptop.

Under the hood it uses the [OCI Image Layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md), which is the boring standard choice and exactly why it works well. One layer, one S3 object. Layers move in parallel, and identical layers are stored once because they are addressed by their SHA256. Nothing proprietary, any OCI-aware tool can read what is in the bucket.

Later I added signing (cosign and AWS KMS), because "prove the image running in prod is the one your CI built" is a question that comes up in every audit I have been through.

## Getting started

```bash
# Homebrew (macOS/Linux)
brew install OuFinx/tap/s3lo

# Or quick install
curl -sSL https://raw.githubusercontent.com/OuFinx/s3lo/main/install.sh | sh
```

Push and pull look how you would expect:

```bash
# Push a local image to S3
s3lo push myapp:v1.0 s3://my-bucket/myapp:v1.0

# Pull it back
s3lo pull s3://my-bucket/myapp:v1.0

# Grab one platform out of a multi-arch image
s3lo pull s3://my-bucket/myapp:v1.0 --platform linux/amd64

# See what is in the bucket
s3lo list s3://my-bucket/
```

Auth goes through the normal AWS credential chain: env vars, `~/.aws/credentials`, instance profiles, SSO. If `aws s3 ls` works for you, so does this.

Different cloud? Same commands, different prefix:

```bash
# Google Cloud Storage
s3lo push myapp:v1.0 gs://my-gcs-bucket/myapp:v1.0

# Azure Blob
AZURE_STORAGE_ACCOUNT=mystorageaccount s3lo push myapp:v1.0 az://my-container/myapp:v1.0

# MinIO or anything S3-compatible
s3lo push myapp:v1.0 s3://my-bucket/myapp:v1.0 --endpoint http://localhost:9000
```

## Pulling images from other registries

This is the command I use most, honestly. `copy` moves an image from Docker Hub, ECR, GHCR or another bucket straight into S3 without the local Docker daemon touching anything.

```bash
# From Docker Hub
s3lo copy nginx:latest s3://my-bucket/nginx:latest

# From ECR, using your existing AWS credentials
s3lo copy 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.0 s3://my-bucket/myapp:v1.0

# Between two buckets, staging to prod
s3lo copy s3://staging-bucket/myapp:v1.0 s3://prod-bucket/myapp:v1.0
```

Multi-arch images copy every platform by default. If you want just one:

```bash
s3lo copy docker.io/library/alpine:latest s3://my-bucket/alpine:latest --platform linux/arm64
```

Before this existed I was pulling locally and re-pushing, which meant a daemon, disk space and about three minutes of my life per image. Not great in CI.

## What is actually in there

A few months in I genuinely did not know what was eating space, or whether deduplication was doing anything at all. Two commands answer that.

`inspect` opens up a single tag:

```bash
s3lo inspect s3://my-bucket/myapp:v1.0
```

```
Reference: s3://my-bucket/myapp:v1.0
Type:      single-arch image
Layers:    6
Total:     312.40 MB

  [1] sha256:9b18e9b68314... (78.21 MB)
  [2] sha256:2f4a5c8d1e77... (54.03 MB)
  ...

Signatures:
  release-signer  (key: awskms:///alias/release-signer, signed: 2026-04-15T10:22:31Z)
```

`s3lo bucket stats` zooms out, and this is where dedup stops being theoretical:

```bash
s3lo bucket stats s3://my-bucket/
```

```
Bucket: s3://my-bucket/

Images:       12
Tags:         47
Storage:      4.1 GB across 89 unique blobs
Dedup savings: 8.3 GB (67.0% — without dedup: 12.4 GB)

Estimated monthly cost:
  S3 (current):              $0.09/month
  S3 (no dedup):             $0.29/month
  ECR equivalent:            $0.41/month
  Savings vs ECR:            $0.32/month (78% cheaper)
```

That 67% is not clever engineering on my part. It is just that all your images sit on the same Ubuntu or Alpine or Node base, and s3lo keeps one copy of each layer instead of forty.

## Keeping the bucket from rotting

Left alone, a bucket collects old tags until the end of time. So there are lifecycle rules, per image or for the whole bucket:

```bash
# Keep the last 10 tags per image, drop anything older than 90 days
s3lo config set s3://my-bucket/ lifecycle.keep_last=10 lifecycle.max_age=90d

# Dry run, nothing is deleted
s3lo bucket clean s3://my-bucket/

# For real this time
s3lo bucket clean s3://my-bucket/ --confirm
```

`clean` prunes tags according to those rules and then collects the blobs nobody references anymore. Skip it for long enough and the dedup savings above quietly stop being true.

## Browsing without typing

Running `list` and then `inspect` in a loop got old, so I built a TUI:

```bash
s3lo tui s3://my-bucket/
```

You get every image with sizes and tag counts, drill into one to see its tags, timestamps and live stats on the right. From there you can delete a tag, inspect it, scan it for vulnerabilities, or hit `g` for a layer sharing matrix that shows which layers are shared across which tags.

It is not going to win a design award, but poking around a bucket is much less painful now.

## Signing

Probably the feature I am happiest with. If you have compliance people, or you just want to know an image was not swapped somewhere along the way:

```bash
# Sign with AWS KMS, which also leaves a CloudTrail trail
s3lo security sign s3://my-bucket/myapp:v1.0 --key awskms:///alias/release-signer

# Verify before you deploy
s3lo security verify s3://my-bucket/myapp:v1.0 --key awskms:///alias/release-signer
```

Exit codes are `0` for valid, `1` for invalid or missing, `2` for infrastructure trouble, so wiring it into a CI gate is one line.

A local cosign key works too:

```bash
COSIGN_PASSWORD=secret s3lo security sign s3://my-bucket/myapp:v1.0 --key cosign.key
s3lo security verify s3://my-bucket/myapp:v1.0 --key cosign.pub
```

The same `security` group also has `scan` (Trivy under the hood) and `sbom`, if you need those in the pipeline.

## From CI

Most pushes happen from CI anyway, not from anyone's laptop. Minimal GitHub Actions step:

```yaml
- name: Push image to S3
  run: |
    curl -Lo s3lo.tar.gz https://github.com/OuFinx/s3lo/releases/latest/download/s3lo_linux_amd64.tar.gz
    tar xzf s3lo.tar.gz && chmod +x s3lo
    ./s3lo push myapp:${{ github.sha }} s3://my-bucket/myapp:${{ github.sha }}
```

For AWS auth I use OIDC, so there are no long-lived keys sitting in secrets. A role that trusts GitHub's OIDC provider plus the bucket policy and you are done.

Mirroring on release fits here too:

```yaml
- run: ./s3lo copy nginx:${{ env.NGINX_VERSION }} s3://my-bucket/nginx:${{ env.NGINX_VERSION }}
```

## Kubernetes

Pulling images by hand is nice, but the whole point was getting them into a cluster without rebuilding how containerd works.

That is **s3lo-operator**. A DaemonSet that runs a small OCI proxy on every node. Containerd is pointed at it through its own `hosts.toml`, so `s3.local` requests go to the local proxy, which turns them into S3 `GetObject` calls.

```
Pod: image: s3.local/my-bucket/myapp:v1.0
  → containerd → hosts.toml → localhost proxy
    → s3lo-proxy → S3 GetObject
  → container starts
```

No containerd restart, no patching anything. Helm install:

```bash
helm install s3lo-operator deploy/helm/s3lo-operator \
  --namespace s3lo \
  --create-namespace \
  --set image.tag=1.4.1
```

Then just reference the image:

```yaml
containers:
  - name: app
    image: s3.local/my-bucket/myapp:v1.0
```

IAM is an EKS Pod Identity role attached to the `s3lo-proxy` service account. Nothing exciting there, which is the point.

## When you do not want the operator

Sometimes you need an OCI endpoint for ten minutes. Local dev, one node, testing before you commit to installing anything.

`s3lo serve` is an HTTP server that speaks the OCI Distribution Spec, so Docker and containerd can pull from it directly:

```bash
# Start it
s3lo serve s3://my-bucket/ --port 5000

# Pull with plain Docker
docker pull localhost:5000/myapp:v1.0
```

For S3 backends the blobs come back as a presigned redirect, so the client downloads straight from S3 and none of the data goes through the server.

## No cloud account at all

There is also a `local://` backend, same OCI layout, no credentials needed:

```bash
# Point s3lo at a directory
s3lo bucket init --local ./local-s3

# Everything else is identical
s3lo push myapp:v1.0 local://./local-s3/myapp:v1.0
s3lo pull local://./local-s3/myapp:v1.0
s3lo tui local://./local-s3/
```

This is how I test almost everything while developing. It also covers air-gapped setups and the case where you want to try s3lo before creating a bucket.

## Conclusion

It started as irritation at a slow pull and turned into a tool I now use every day. One bucket, no registry to babysit, and pulls that finish before the coffee does.

Both projects are open source: [s3lo](https://github.com/OuFinx/s3lo) and [s3lo-operator](https://github.com/OuFinx/s3lo-operator).

If you try it and something breaks, tell me below 🚀
