---
title: 'MirrorMaker 2 Consumer Group Offsets Not Syncing: Causes and Fixes'
description: 'Messages replicate fine but consumer group offsets never show up on the target cluster. Here is what MM2 is actually doing, and the eight reasons it silently refuses to sync.'
author: 'OuFinx'
pubDate: '2026-07-31'
heroImage: '../../assets/mm2/mm2-offsets-hero.png'
tags: ['Kafka', 'MirrorMaker', 'DevOps']
---

## Introduction

Another ordinary working day. Replication between two Kafka clusters was green, lag on the mirrored topics was zero, everything looked healthy on the dashboards.

Then someone asked the reasonable question: if we fail over right now, where do the consumers start from?

I ran `kafka-consumer-groups --describe` against the target cluster and got nothing. No group. Messages had been replicating for weeks, but not a single consumer offset had ever made it across.

Nothing in the logs. No error, no warning, no failed task. MM2 was just quietly not doing it.

That turned into a long afternoon, so here is everything I ended up learning, in the order I wish I had learned it 🙂

This is a follow-up to my earlier post on [resetting offsets in MirrorMaker 2](/posts/kafka-mirror-maker-reset-offsets/). Same two clusters, `hello` and `world`, same setup.

## First, what MM2 is actually doing

The thing that confused me the longest: **replicating messages and replicating consumer offsets are two completely separate jobs**, done by two different connectors, through three different internal topics.

<div class="flow">

<div class="flow-step">
<div class="flow-num">1</div>
<div class="flow-body">
<div class="flow-title">MirrorSourceConnector</div>
<p><span class="flow-key">copies</span> <code>hello:orders</code> <span class="flow-to">→</span> <code>world:hello.orders</code></p>
<p><span class="flow-key">writes</span> the offset mapping to <code>mm2-offset-syncs.hello.internal</code></p>
<p class="flow-note"><code>orders-0: src 1200 = dst 1187</code> - one record per <code>offset.lag.max</code></p>
</div>
</div>

<div class="flow-arrow" aria-hidden="true"></div>

<div class="flow-step">
<div class="flow-num">2</div>
<div class="flow-body">
<div class="flow-title">MirrorCheckpointConnector</div>
<p><span class="flow-key">reads</span> that mapping, plus <code>hello:__consumer_offsets</code> holding <code>my-group = 1200</code></p>
<p><span class="flow-key">translates</span> <code>1200</code> <span class="flow-to">→</span> <code>1187</code></p>
<p><span class="flow-key">writes</span> the result to <code>hello.checkpoints.internal</code></p>
</div>
</div>

<div class="flow-arrow" aria-hidden="true"></div>

<div class="flow-step">
<div class="flow-num">3</div>
<div class="flow-body">
<div class="flow-title">Only if <code>sync.group.offsets.enabled = true</code></div>
<p><span class="flow-key">writes</span> <code>my-group = 1187</code> into <code>world:__consumer_offsets</code></p>
<p class="flow-note">This last one is what your consumers actually read after a failover. Skip it and the first two steps were decoration.</p>
</div>
</div>

</div>

Three internal topics, three different jobs:

| Topic | Holds |
|---|---|
| `mm2-offset-syncs.<cluster>.internal`<br/>_source cluster, MirrorSource_ | raw source offset → target offset pairs |
| `<source>.checkpoints.internal`<br/>_target cluster, MirrorCheckpoint_ | translated offsets, per consumer group |
| `__consumer_offsets`<br/>_target cluster, MirrorCheckpoint_ | the committed offsets your consumers actually read |

Offsets have to walk that whole chain. Break any link and the symptom is the same: nothing on the target, no error anywhere.

Why translation at all? Because offsets do not survive a copy. A message at offset 1200 on the source can land at 1187 on the target, since the target topic was created later, or replication started mid-stream, or retention already ate the head of the source topic. Copying the number 1200 across would put your consumer at the wrong message, or at one that does not exist yet.

## The defaults nobody reads

Straight from the Kafka source, because half the problems are here:

| Config | Default | What it does |
|---|---|---|
| `emit.checkpoints.enabled` | `true` | write to `.checkpoints.internal` |
| `emit.checkpoints.interval.seconds` | `60` | how often |
| **`sync.group.offsets.enabled`** | **`false`** | write to the target's `__consumer_offsets` |
| `sync.group.offsets.interval.seconds` | `60` | how often |
| `refresh.groups.enabled` | `true` | discover new consumer groups |
| `refresh.groups.interval.seconds` | `600` | every 10 minutes |
| `groups` | `.*` | which groups to replicate |
| `groups.exclude` | `console-consumer-.*`, `connect-.*`, `__.*` | which to skip |
| `offset.lag.max` | `100` | records between offset-sync records |
| `offset-syncs.topic.location` | `source` | where offset-syncs lives |
| `checkpoints.topic.replication.factor` | `3` | RF of the checkpoints topic |

The bolded one is the answer roughly half the time. Keep reading anyway, the other half is more interesting.

## Symptom to cause, at a glance

| What you see | Most likely cause |
|---|---|
| Group does not exist on target at all | `sync.group.offsets.enabled` is false (#1) |
| `.checkpoints.internal` topic is empty or missing | checkpoint connector not running, or group filtered out (#3, #4) |
| Checkpoints have data, `__consumer_offsets` does not | consumers are already running on the target (#2) |
| `UnknownMemberIdException` in the MM2 logs | same thing, #2, confirmed |
| Offsets sync but freeze at an old value | consumer is behind the replication flow (#7) |
| Negative lag on the target | version bug, or offsets copied untranslated (#8) |
| Some topics sync, others do not | topic filter, or no offset syncs for those partitions yet (#5) |
| Group appears only after 10 minutes | `refresh.groups.interval.seconds` is 600 (#4) |

Now the details.

### 1. sync.group.offsets.enabled is false

It defaults to `false`. Checkpoints are being emitted, the `.checkpoints.internal` topic is filling up nicely, and MM2 is doing exactly nothing with them.

Checkpoints are a record of where offsets *would* be. Writing them into the target's `__consumer_offsets` is a separate, opt-in step.

```properties
hello->world.sync.group.offsets.enabled: true
hello->world.sync.group.offsets.interval.seconds: 30
hello->world.emit.checkpoints.interval.seconds: 30
```

One warning before you turn this on for an active/active setup: do not enable it in both directions. Each side will keep overwriting the other's offsets and your consumers will bounce around forever.

### 2. Consumers are already running on the target

This one cost me the most time, and it is the one nobody documents clearly.

Offsets do not land in a consumer group that has active members on the target cluster. This is not a bug, and it is enforced twice.

First, MM2 only bothers to look up the current position of groups that are idle. `MirrorCheckpointTask` checks the state before reading anything:

```java
// sync offset to the target cluster only if the
// state of current consumer group is:
// (1) idle: because the consumer at target is not
//     actively consuming the mirrored topic
// (2) dead: the new consumer that is recently
//     created at source and never existed at target
if (consumerGroupState == GroupState.EMPTY) {
```

| Group state on target | Offsets sync? |
|---|---|
| does not exist / `DEAD` | ✅ yes, treated as new |
| `EMPTY` (no members) | ✅ yes |
| `STABLE` | ❌ no |
| `PREPARING_REBALANCE` | ❌ no |
| `COMPLETING_REBALANCE` | ❌ no |

Second, for a group MM2 has never seen before it goes ahead and tries the write anyway, via `alterConsumerGroupOffsets`. The broker is the one that says no: you cannot commit offsets for a group that has live members from outside that group. It is the same rule that makes `kafka-consumer-groups --reset-offsets` refuse on an active group. That rejection is what produces the warning further down.

The reasoning is sound. You do not want a background job yanking the position out from under a consumer that is mid-flight. But it means the whole feature is designed for **active/passive**: the target group stays idle until failover, and MM2 keeps it warm.

If you had a consumer connected to the target "just to test", that is your answer. Check it:

```bash
kafka-consumer-groups.sh --bootstrap-server $TARGET \
  --describe --group my-group --state
```

```
GROUP     COORDINATOR (ID)   ASSIGNMENT-STRATEGY  STATE   #MEMBERS
my-group  b-1.world:9092 (1) range               Stable  3
```

`Stable` with members means MM2 will not touch it. Stop those consumers, wait one `sync.group.offsets.interval.seconds`, and check again.

If they were running, you may also find this in the MM2 logs, which is the single most useful line in this entire article:

```
WARN Unable to sync offsets for consumer group my-group. This is likely
caused by consumers currently using this group in the target cluster.
```

It is logged at WARN, not ERROR, so it does not show up on any alert. Grep for it explicitly.

### 3. The checkpoint connector is not running

`MirrorCheckpointConnector` is a separate connector from `MirrorSourceConnector`. Replication working proves nothing about it.

```bash
curl -s $CONNECT_REST/connectors | jq
curl -s $CONNECT_REST/connectors/MirrorCheckpointConnector/status | jq
```

Watch for `tasks: []` with the connector itself `RUNNING`. That is the sneaky failure mode: no tasks means no checkpoints, and the connector still reports healthy. Usually it means MM2 found no groups to replicate, which leads directly to the next one.

### 4. Your group is filtered out

`groups.exclude` defaults to `console-consumer-.*, connect-.*, __.*` and **excludes always beat includes**. If your group is called `connect-elasticsearch-sink`, it is silently dropped by the default config.

```properties
hello->world.groups: my-group,orders-.*
hello->world.groups.exclude: console-consumer-.*,__.*
```

Note that overriding `groups.exclude` replaces the whole default list. If you still want `connect-.*` gone, list it again.

Also worth knowing: new groups are only discovered every `refresh.groups.interval.seconds`, which is 600 by default. A group created two minutes ago is simply not visible to MM2 yet. Do not debug for ten minutes what a ten-minute timer explains.

### 5. There is nothing to translate yet

Two independent reasons a partition produces no checkpoint:

**No offset syncs exist for it.** The source connector writes an offset-sync record roughly every `offset.lag.max` (100) records per partition. A low-traffic topic that has produced 12 messages since MM2 started may have zero syncs, so translation for that partition returns nothing and the checkpoint is dropped. In `checkpointsForGroup` these are filtered out with a comment saying exactly that.

**The topic is not being replicated.** Checkpoints are filtered by the same topic filter as replication. If `orders` is not in `topics`, its offsets are not going anywhere either.

Read the offset-syncs topic directly. Kafka ships formatters for these:

```bash
kafka-console-consumer.sh --bootstrap-server $SOURCE \
  --topic mm2-offset-syncs.hello.internal \
  --from-beginning \
  --formatter org.apache.kafka.connect.mirror.formatters.OffsetSyncFormatter
```

```
OffsetSync{topicPartition=orders-0, upstreamOffset=1200, downstreamOffset=1187}
```

And the checkpoints, on the target:

```bash
kafka-console-consumer.sh --bootstrap-server $TARGET \
  --topic hello.checkpoints.internal \
  --from-beginning \
  --formatter org.apache.kafka.connect.mirror.formatters.CheckpointFormatter
```

```
Checkpoint{consumerGroupId=my-group, topicPartition=hello.orders-0,
           upstreamOffset=1200, downstreamOffset=1187, metadata=}
```

Empty offset-syncs means the source connector's problem. Offset-syncs full but checkpoints empty means the checkpoint connector's problem. That single distinction cuts the search space in half.

### 6. offset-syncs.topic.location set on only one connector

`offset-syncs.topic.location` defaults to `source`, which means the checkpoint connector needs read access to a topic on the *source* cluster. If your MM2 principal only has permissions on the target, or if the source is a managed cluster you do not fully control, this quietly fails.

Moving it to the target is a common fix, but it has to be set on **both** connectors. Set it on only one and they look at different clusters for the same topic:

```properties
hello->world.offset-syncs.topic.location: target
```

The prefixed form above applies to both. If you configure connectors individually, set it in both places. And changing it after the fact abandons the existing offset-syncs topic, so translation restarts from scratch.

### 7. The consumer is further behind than the replication flow

This one produces the confusing symptom: offsets sync, then stop advancing, while replication is clearly fine.

MM2 stores a bounded set of offset syncs per partition, spaced roughly exponentially, and translates using the sync that most closely precedes the consumer's position. If your consumer is so far behind that no stored sync covers it, MM2 refuses to guess. `checkpointsForGroup` drops anything it cannot translate accurately:

```java
// ignore offsets we cannot translate accurately
.filter(x -> x.downstreamOffset() >= 0)
```

Refusing is the correct behaviour. A wrong translation means skipped or double-processed messages after failover, which is much worse than a stale checkpoint. But it does mean a badly lagging consumer group gets stale offsets on the target, and you will not be told.

If this is you: fix the lag on the source, or lower `offset.lag.max` so syncs are denser (at the cost of more traffic on the offset-syncs topic).

```properties
hello->world.offset.lag.max: 25
```

There is one more guard worth knowing, in `syncGroupOffset`: if the translated offset is *lower* than what the target group already has, MM2 skips it. Offsets never move backwards. So if the target group has a stale high offset from an old test, the sync will look broken until you reset that group.

### 8. You are on a Kafka version with a known bug

Offset translation has been rewritten more than once. If your MM2 is older than 3.5, some of what you are seeing may not be your config at all:

| Issue | Symptom | Fixed in |
|---|---|---|
| [KAFKA-12468](https://issues.apache.org/jira/browse/KAFKA-12468) | source offsets copied untranslated on first sync, negative lag everywhere | 3.3.3 / 3.4.1 / 3.5.0 |
| [KAFKA-12635](https://issues.apache.org/jira/browse/KAFKA-12635) | empty target partition gets the literal untranslated offset, negative lag on that partition | 3.3.0 |
| [KAFKA-14666](https://issues.apache.org/jira/browse/KAFKA-14666) | translation refuses for groups behind the replication flow | 3.3.3 / 3.4.1 / 3.5.0 |

If you see **negative lag** on the target, that is the fingerprint of an untranslated offset. Check your version before checking anything else.

## The debug order that actually works

Do not start with the config. Start by finding out which link in the chain is broken:

```
Group exists on target?
│
├─ NO
│  └─ checkpoints has data?
│     │
│     ├─ NO
│     │  └─ offset-syncs has data?
│     │     ├─ NO  ──▶ #5
│     │     └─ YES ──▶ #3 #4 #6
│     │
│     └─ YES
│        ├─▶ #1 sync.group.offsets
│        └─▶ #2 grep logs for
│          UnknownMemberIdException
│
└─ YES, but offsets look wrong
   ├─ frozen       ──▶ #7
   └─ negative lag ──▶ #8
```

Four commands cover the whole tree:

```bash
# 1. does the group exist on target
kafka-consumer-groups.sh --bootstrap-server $TARGET \
  --list | grep my-group

# 2. is anything consuming it right now
kafka-consumer-groups.sh --bootstrap-server $TARGET \
  --describe --group my-group --state

# 3. are checkpoints being produced
kafka-console-consumer.sh --bootstrap-server $TARGET \
  --topic hello.checkpoints.internal --from-beginning --max-messages 5 \
  --formatter org.apache.kafka.connect.mirror.formatters.CheckpointFormatter

# 4. are offset syncs being produced
kafka-console-consumer.sh --bootstrap-server $SOURCE \
  --topic mm2-offset-syncs.hello.internal --from-beginning --max-messages 5 \
  --formatter org.apache.kafka.connect.mirror.formatters.OffsetSyncFormatter
```

## A config that works

This is roughly what I run now, active/passive, offsets flowing one way only:

```properties
clusters: hello, world
hello.bootstrap.servers: b-1.hello:9092
world.bootstrap.servers: b-1.world:9092

hello->world.enabled: true
hello->world.topics: orders,payments

# offsets, the part that is off by default
hello->world.emit.checkpoints.enabled: true
hello->world.emit.checkpoints.interval.seconds: 30
hello->world.sync.group.offsets.enabled: true
hello->world.sync.group.offsets.interval.seconds: 30

# denser syncs, better translation for lagging consumers
hello->world.offset.lag.max: 25

# find new groups faster than every 10 minutes
hello->world.refresh.groups.interval.seconds: 60

# keep the defaults out, list what you want
hello->world.groups: orders-consumer,payments-consumer
hello->world.groups.exclude: console-consumer-.*,__.*

# reverse direction replicates data only, never offsets
world->hello.enabled: true
world->hello.sync.group.offsets.enabled: false
```

## Verifying before you need it

The worst time to discover offset sync never worked is during an actual failover. Verify it on a normal Tuesday instead:

1. Stop the consumer group on the source cluster.
2. Wait one `sync.group.offsets.interval.seconds`.
3. Describe the group on the target. `CURRENT-OFFSET` should be populated and `LAG` should be a sane positive number.
4. Start one consumer against the target and confirm it picks up roughly where the source left off.

Some duplicates are expected. Syncing is time-based, so anything committed on the source between the last sync and the failover gets reprocessed. Plan for at-least-once, not exactly-once.

## Conclusion

Almost every "MM2 is not syncing offsets" case comes down to one of three things:

- `sync.group.offsets.enabled` is `false`, which is the default 🙂
- something is actively consuming the group on the target, so MM2 refuses to touch it
- the offsets never made it to the checkpoints topic in the first place

Work the chain, not the config: offset-syncs → checkpoints → `__consumer_offsets`. The formatters tell you exactly which hop is broken in about thirty seconds.

And grep for that `UnknownMemberIdException` warning. It is the answer far more often than it has any right to be.

If you hit a case that is not on this list, drop it in the comments and I will add it 🚀
