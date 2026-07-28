---
title: 'How I Built an Alternative to Docker Registries Using Just an S3 Bucket'
description: 'A pet project that turned into a real ECR alternative. Store Docker images on S3, pull at 100 Gbps, sign them for audits, and use them natively in Kubernetes.'
author: 'OuFinx'
pubDate: '2026-04-18'
heroImage: '../../assets/s3lo/s3lo-hero.png'
tags: ['Kubernetes', 'AWS', 'Docker', 'S3', 'DevOps']
---

## Introduction

It was an ordinary working day. I pushed a new deployment to EKS, went to grab a coffee, came back... and the pod was still in `ContainerCreating`. The image was around 2 GB, and ECR was taking its time. This happened again and again, every deploy.

At some point I got tired of it and started digging around. And then I stumbled on an article where someone had tested storing Docker images directly on S3. The pull speeds were wild: up to **100 Gbps** on EC2 instances thanks to native S3 bandwidth. And the storage cost was less than a quarter of what ECR charges.

I thought: why doesn't this exist as a proper tool?

So I built one 🙂

## The Problem with Traditional Registries

ECR, Docker Hub, GHCR. They all work fine for most cases. But when you're inside AWS pulling large images frequently, the friction adds up:

| | ECR / Docker Hub | s3lo |
|---|---|---|
| **Pull speed** | ~1–5 Gbps | Up to 100 Gbps on EC2 |
| **Storage cost** | $0.10/GB/month | $0.023/GB/month (S3 Standard) |
| **Cloud support** | Vendor-specific | AWS S3, GCS, Azure Blob, MinIO, R2, Ceph |
| **Registry to manage** | Yes | Just a bucket |

The speed difference comes from S3's internal network inside AWS. EC2 instances and EKS nodes get direct high-bandwidth access to S3, which a regular registry endpoint can't match.

And honestly, the simplicity is underrated. No registry to provision, no lifecycle policies to configure, no separate IAM setup beyond a basic bucket policy. It's just S3.

## Introducing s3lo

**s3lo** is a CLI tool written in Go that lets you push and pull Docker images to any S3-compatible storage: AWS S3, Google Cloud Storage, Azure Blob, MinIO, Cloudflare R2, Ceph, or even local disk.

It stores images using the [OCI Image Layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) format. Each layer is a separate S3 object, which means:

- **Parallel uploads and downloads**: layers transfer simultaneously
- **Cross-image deduplication**: if two images share a base layer, it's stored once (SHA256-addressed)
- **No proprietary format**: standard OCI, readable by any compatible tool

And because I was building this for real production use, I also added **image signing**, compatible with cosign and AWS KMS. This matters when you have security audits: you can prove that what's running in your cluster is exactly what was pushed from your CI pipeline.

## Practical Guide

### Install

```bash
# Homebrew (macOS/Linux)
brew install OuFinx/tap/s3lo

# Or quick install
curl -sSL https://raw.githubusercontent.com/OuFinx/s3lo/main/install.sh | sh
```

### Push & Pull

```bash
# Push a local image to S3
s3lo push myapp:v1.0 s3://my-bucket/myapp:v1.0

# Pull it back
s3lo pull s3://my-bucket/myapp:v1.0

# Pull a specific platform from a multi-arch image
s3lo pull s3://my-bucket/myapp:v1.0 --platform linux/amd64

# List images in the bucket
s3lo list s3://my-bucket/
```

Authentication uses the standard AWS credential chain: environment variables, `~/.aws/credentials`, IAM instance profiles, SSO. If you already use the AWS CLI, it just works.

Want to use a different cloud? Same commands, different prefix:

```bash
# Google Cloud Storage
s3lo push myapp:v1.0 gs://my-gcs-bucket/myapp:v1.0

# Azure Blob
AZURE_STORAGE_ACCOUNT=mystorageaccount s3lo push myapp:v1.0 az://my-container/myapp:v1.0

# MinIO or any S3-compatible storage
s3lo push myapp:v1.0 s3://my-bucket/myapp:v1.0 --endpoint http://localhost:9000
```

### Mirror from Any Registry

One thing I use constantly: pulling images directly from Docker Hub, ECR, or GHCR into S3 without touching the local Docker daemon. It's called `copy`, and it saves a lot of manual steps in CI pipelines.

```bash
# Mirror from Docker Hub
s3lo copy nginx:latest s3://my-bucket/nginx:latest

# Copy from ECR (uses your AWS credentials automatically)
s3lo copy 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:v1.0 s3://my-bucket/myapp:v1.0

# Copy between two S3 buckets (staging → production)
s3lo copy s3://staging-bucket/myapp:v1.0 s3://prod-bucket/myapp:v1.0
```

For multi-arch images (like `linux/amd64` + `linux/arm64`), all platforms are copied by default. If you only need one:

```bash
s3lo copy docker.io/library/alpine:latest s3://my-bucket/alpine:latest --platform linux/arm64
```

This was a big quality-of-life improvement over pulling locally and re-pushing. No daemon involvement, no temporary disk usage.

### See What You're Actually Storing

After a few months of pushing images, I wanted to understand what was taking up space and whether deduplication was actually working. Two commands do this well.

`inspect` shows the internals of a specific tag: layers, sizes, platforms for multi-arch images, and whether it's signed:

```bash
s3lo inspect s3://my-bucket/myapp:v1.0
# Reference:  s3://my-bucket/myapp:v1.0
# Type:       single-arch image
# Layers:     6
# Total:      312.4 MB
# Signed:     yes
```

`stats` shows the bucket-wide picture - and this is where the deduplication savings become very real:

```bash
s3lo stats s3://my-bucket/
# Images:        12
# Tags:          47
# Unique blobs:  89
# Total size:    4.1 GB
#
# Dedup savings: 8.3 GB (67% saved)
#
# Estimated monthly cost: $0.09
# vs ECR equivalent:      $0.41 (4.6× cheaper)
```

That "67% saved" number is because all your images share the same base layers (Ubuntu, Alpine, Node.js runtime, etc.), and s3lo only stores each unique layer once.

### Keep Your Bucket Clean

Without lifecycle rules, buckets accumulate old tags forever. I added a way to configure this per image or bucket-wide:

```bash
# Keep the last 10 tags per image, delete anything older than 90 days
s3lo config set s3://my-bucket/ lifecycle.keep_last=10 lifecycle.max_age=90d

# Preview what would be cleaned (dry run)
s3lo clean s3://my-bucket/

# Actually run it
s3lo clean s3://my-bucket/ --confirm
```

The clean command prunes old tags based on lifecycle rules, then runs garbage collection to remove unreferenced blobs. Running this regularly is what keeps the deduplication savings meaningful.

### Browse Interactively

Checking stats and inspecting images from the command line works, but sometimes you just want to browse. I recently added a TUI - a full interactive terminal UI:

```bash
s3lo tui s3://my-bucket/
```

It shows all images with their sizes and tag counts. Navigate into an image to see all tags, their individual sizes, timestamps, and live stats on the right panel. From there you can delete a tag, inspect its metadata, scan it for vulnerabilities, or press `g` to open a layer sharing matrix that shows exactly which layers are shared across which tags.

Nothing fancy, but it makes exploring a bucket much more comfortable than running `list` and `inspect` in loops.

### Image Signing

This was one of the features I'm most happy about adding. If you need to meet compliance requirements or just want to know that images haven't been tampered with:

```bash
# Sign with AWS KMS (leaves an audit trail in CloudTrail)
s3lo sign s3://my-bucket/myapp:v1.0 --key awskms:///alias/release-signer

# Verify before deploying
s3lo verify s3://my-bucket/myapp:v1.0 --key awskms:///alias/release-signer
```

Exit codes: `0` = valid, `1` = invalid or missing signature, `2` = infrastructure error. Easy to wire into a CI gate.

You can also use a local cosign key if you prefer:

```bash
COSIGN_PASSWORD=secret s3lo sign s3://my-bucket/myapp:v1.0 --key cosign.key
s3lo verify s3://my-bucket/myapp:v1.0 --key cosign.pub
```

### CI Integration

In practice, most pushes happen from CI, not laptops. Here's a minimal GitHub Actions job:

```yaml
- name: Push image to S3
  run: |
    curl -Lo s3lo.tar.gz https://github.com/OuFinx/s3lo/releases/latest/download/s3lo_linux_amd64.tar.gz
    tar xzf s3lo.tar.gz && chmod +x s3lo
    ./s3lo push myapp:${{ github.sha }} s3://my-bucket/myapp:${{ github.sha }}
```

For AWS authentication in Actions, I use OIDC - no long-lived access keys needed. Just configure a role that trusts GitHub's OIDC provider and attach the bucket policy.

If you want to mirror from Docker Hub or ECR on every release, `copy` fits here too:

```yaml
- run: ./s3lo copy nginx:${{ env.NGINX_VERSION }} s3://my-bucket/nginx:${{ env.NGINX_VERSION }}
```

### Kubernetes Integration

Pushing images and pulling them manually is useful, but the real win is using them directly in Kubernetes, without changing how containerd works or patching anything.

That's what **s3lo-operator** does. It's a DaemonSet that runs a lightweight OCI-compatible proxy on each node. Containerd is configured via native `hosts.toml` to route `s3.local` requests through the proxy, which translates them into S3 `GetObject` calls.

```
Pod: image: s3.local/my-bucket/myapp:v1.0
  → containerd → hosts.toml → localhost proxy
    → s3lo-proxy → S3 GetObject
  → container starts
```

No containerd restart. No patching. Just a Helm install:

```bash
helm install s3lo-operator deploy/helm/s3lo-operator \
  --namespace s3lo \
  --create-namespace \
  --set image.tag=1.0.0
```

Then in your pod spec:

```yaml
containers:
  - name: app
    image: s3.local/my-bucket/myapp:v1.0
```

For IAM, you associate a role with the `s3lo-proxy` service account using EKS Pod Identity. Standard stuff, nothing exotic.

### Serve Images Without the Operator

The operator is the right answer for production Kubernetes, but sometimes you just need a quick OCI-compatible endpoint - for local development, for a single node, or for testing before installing the operator.

`s3lo serve` starts a lightweight HTTP server that speaks the OCI Distribution Spec. Any Docker client or containerd can pull from it directly:

```bash
# Start the server
s3lo serve s3://my-bucket/ --port 5000

# Pull from it with Docker (no s3lo pull needed)
docker pull localhost:5000/myapp:v1.0
```

For S3 backends, blobs are served via presigned redirect - the server just returns a signed URL and the client downloads directly from S3. No data goes through the server itself.

### No Cloud Account? Try Local Storage

I also built a `local://` backend for development and testing. It uses the same OCI layout as S3, so everything works identically - no cloud account, no credentials:

```bash
# Initialize a local directory as storage
s3lo init --local ./local-s3

# Push, pull, list - same commands
s3lo push myapp:v1.0 local://./local-s3/myapp:v1.0
s3lo pull local://./local-s3/myapp:v1.0
s3lo tui local://./local-s3/
```

This is how I test most features during development. It's also useful for air-gapped environments or for trying s3lo before committing to a bucket.

## Conclusion

What started as frustration over slow image pulls grew into something more complete than I expected: push/pull to any object storage, mirroring from any registry, image signing for audit trails, lifecycle management, a TUI for browsing, and native Kubernetes integration without patching anything.

One S3 bucket. No registry to manage. And much faster pulls when it matters.

The project is open source - check it out on GitHub: [s3lo](https://github.com/OuFinx/s3lo) and [s3lo-operator](https://github.com/OuFinx/s3lo-operator).

Feel free to share your thoughts below 🚀
