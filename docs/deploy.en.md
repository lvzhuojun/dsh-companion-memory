# Deployment

> [中文](deploy.md) | English

These are generic steps for deploying the memory system as a DSH plugin: packaging, the preset, configuration, the nightly review, the 0.7 migration, upgrades and rollbacks, and security recommendations. All paths are examples; substitute your own.

## 1. Prerequisites

- A working DeepSeek Harness (DSH) installation and a profile to attach memory to.
- Node.js ≥ 22.12, for the built-in `node:sqlite`. The nightly review reads DSH's zstd-compressed session logs, so Node must also support `zlib.zstdDecompressSync`.
- An **Anthropic-compatible** model endpoint (the nightly review calls `<baseUrl>/v1/messages`). All our evaluations use deepseek-flash.
- A dedicated OS user that runs DSH. The life directory (diaries, `self.md`, `memory.db`) should be readable and writable by that user only.

## 2. Packaging and installing the plugin

```bash
npm ci
npm run build                                   # compile packages/* (the bundler reads dist)
npm run bundle -w @dsh-companion/dsh-plugin     # → packages/dsh-plugin/bundle/: lib/index.js, lib/compaction.js, package.json
```

The output is a zero-dependency single-file plugin named `dsh-her-life`. The preset (section 3; full template in [`templates/cordis.patch.example.yml`](../templates/cordis.patch.example.yml)) must live at `packages/dsh-plugin/bundle/cordis.patch.yml` (the package's `package.json` points to it via `dsh.bundle.patch`): pass `-- --patch <your preset file>` when bundling to copy it in automatically, or drop it in by hand afterwards. Then:

```bash
cd packages/dsh-plugin/bundle
npm pack                                        # → dsh-her-life-<version>.tgz
dsh plugin --profile <profile> add ./dsh-her-life-<version>.tgz
```

`dsh plugin add` passes its arguments through to pnpm, so a local tgz or a tgz download URL both work. Package sources inside the monorepo can't be installed directly (they are TypeScript and depend on sibling packages), so always install the bundle. After restarting DSH, the log shows a `[her-life] 已挂载：…` ("mounted") line and the state of every switch.

## 3. The preset

```yaml
- insert:
    - id: preset-companion
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: companion
        name: companion
        description: Companion session with long-term memory
        plugins:
          - id: her-life
            name: 'dsh-her-life'
            config:
              seedPath: /srv/companion/seed.md       # the seed: root-owned, 0644, read-only for her
              lifeDir: /home/companion/life          # life directory: self.md, diary/, proposals/, memory.db
              ownerName: 主人
              ownerBook: to_owner
              variablePrefix: companion
              privateDiaryAudited: false
              blockTools: [qq_bridge_napcat]         # global tools this session must not use
              # read side
              askFirst: true                         # C
              timeCalc: true                         # D
              prerecall: true                        # R
              followTrigger: true                    # K
              followUpLoose: true                    # F
              followUpWeight: true                   # W
              memoryKeys: true                       # S
              # 0.7
              memorySlots: true                      # Y
              personCard: true                       # T
              # crisis: true                         # Z: see section 6
              # emergencyContact: '<private preset only>'
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: "{{companion_seed}}\n\n---\n\n# Who I am\n\n{{companion_self}}\n\n---\n\n{{companion_memory}}"
              complete: true
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: 'dsh-her-life/compaction'      # optional: Chinese companion compaction; use '@deepseek-ai/dsh-compaction-basic' for the default
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
```

- There are three prompt variables: `{{<prefix>_seed}}` (the seed), `{{<prefix>_self}}` (the self.md she writes herself) and `{{<prefix>_memory}}` (memory rules + stable layer). The prefix comes from `variablePrefix`, and the preset's `prefix` must use the same one.
- `dsh-her-life/compaction` is a Chinese companion-style compaction. It subclasses DSH's compaction-basic and only replaces the summary instruction, so its options (`thresholdRatio`, `retainTokens`) are identical. If compaction-basic can't be found, it doesn't take over; it only logs a warning.
- Every setting and switch is explained in [`architecture.en.md` section 5](architecture.en.md#5-switches). All switches default to off. Paired switches (S, Y, T, K, F, W) must also be enabled in the nightly review.
- A seed template is in [`templates/seed.template.md`](../templates/seed.template.md). The seed never changes after "birth". She describes who she is in self.md herself, and changes go through the `propose_self_change` review queue.

## 4. The nightly review

The nightly review is a separate small program that runs once a night within a configured window. It reads the day's session log and lets her review the day in the first person, writing memories, follow-ups, diary entries and person cards.

### 4.1 Packaging

```bash
npm run deploy:night:pack        # runs tsc -b, then esbuild bundles deploy/night/night-review.ts into a single night-review.mjs
```

### 4.2 Configuration (`config.json`)

| Key | Required | Notes |
|---|---|---|
| `lifeDir` | yes | Life directory (same as the plugin's `lifeDir`) |
| `sessionLog` | yes | Her session's log file (`sessions/…/<session>/session.v4.jsonl.zstd` under the DSH data directory) |
| `sessionId` | yes | Session id (used as the key of the review cursor) |
| `ownerName` / `ownerBook` / `privateDiaryAudited` | yes | Must match the plugin preset |
| `baseUrl` | yes | Anthropic-compatible endpoint (without `/v1/messages`) |
| `model` | yes | Model name, e.g. `deepseek-flash` |
| `effort` | yes | Reasoning effort; `high` is recommended for the nightly review |
| `budget` | yes | Nightly cap in CNY; when reached, it stops at the current segment and continues the next night |
| `window` | yes | `{ "start": "HH:MM", "end": "HH:MM" }`; it only runs inside this window (Beijing time; pick the late-night hours with the least conversation) |
| `prices` | no | `{ "miss": 1.0, "hit": 0.02, "out": 4.0 }`, CNY per million tokens; used for cost estimates |
| `maxChars` / `maxSteps` | no | Max characters of material per segment / max steps per segment |
| `style` | no | `{ "detail": true, "privacy": true, "changes": true }`: switches A / B / I |
| `followUp` | no | `{ "loose": true, "keys": true, "weight": true }`: switches F / K / W (`mid` is switch M) |
| `lean` | no | Switch N: lean night |
| `synonyms` | no | Switch S: synonym keys |
| `slots` | no | Switch Y: validity + keys |
| `card` | no | Switch T: person cards |

The model key is read from the `DEEPSEEK_API_KEY` environment variable. It never goes in the config file and is never printed.

### 4.3 Running it

```bash
node --no-warnings night-review.mjs /etc/companion-night/config.json              # normal run (exits immediately outside the window)
node --no-warnings night-review.mjs /etc/companion-night/config.json --rehearse /tmp/night-rehearsal   # rehearsal
```

- **Rehearsal** (`--rehearse <empty dir>`): builds a fictional day and a temporary life directory in that directory, runs the whole thing against the real endpoint, prints only numbers and the categories of what was written, then deletes the directory. It doesn't touch anything of hers. Rehearse once before going live.
- **Scheduling.** Trigger it once a night inside the window with cron or a systemd timer. It must run as the **same OS user as DSH**, because `memory.db` is 0600. If DSH runs in a sandbox (read-only system, restricted writable paths), give the nightly review the same sandbox settings.
- **Output.** It prints only lines starting with `[night-review]`, carrying numbers, status and reasons. It never prints conversation, anything she wrote, or the system prompt. Exit codes: 0 done, or no new conversation today; 1 error; 3 incomplete (budget or step cap reached, it continues next time); 64 usage error.
- Dates and windows are currently computed in Beijing time (UTC+8).

## 5. Upgrading to 0.7 and migrating

The new plugin adds columns and tables automatically the first time it opens the store, without bumping the schema version, so it works without running the migration. The migration script adds three extras: an online backup, backfilled keys for existing rows, and an integrity check.

```bash
npx tsc -b
npx esbuild deploy/migrate/0.7.mjs --bundle --platform=node --format=esm --target=node22 --outfile=out/migrate-0.7.mjs
```

On the server, run it as the DSH OS user, preferably with DSH stopped:

```bash
node --no-warnings migrate-0.7.mjs /home/companion/life/memory.db --dry-run   # read-only: counts how many rows would be tagged
node --no-warnings migrate-0.7.mjs /home/companion/life/memory.db             # backup → add columns/tables → backfill keys → integrity check
```

- The backup goes in the same directory as `memory.db.pre-0.7-<Beijing time>`, and its row count and `integrity_check` are verified afterwards.
- The backfill only **tags** rows (`slot_by = 'system'`). It retires nothing and writes no validity dates. Other people's matters are not tagged.
- Only counts, key names and the backup file name are printed, never the content of any row.
- Exit codes: 0 done; 1 error (the store was untouched, or the change was rolled back); 2 usage error; 3 done but the integrity check found a mismatch. The backup is there; don't start DSH yet.

## 6. Crisis protocol (switch Z)

With `crisis: true`, every message from a real person goes through the lexical classifier first. During the caution period she gets guidance on every turn, and at high levels code notifies the emergency contact directly (see [`architecture.en.md` section 7](architecture.en.md#7-crisis-protocol-switch-z)).

- **Notification channel.** The bundled implementation calls a host tool that can send a direct message (`qq_bridge_send` by default), addressed to `emergencyContact`. The startup log reports whether the notification channel is available, and if not, why.
- **Using another channel** (email, webhook, chat bot). On the engine side, `CrisisWatch.observe()` only returns `notify: { level, text }`; delivery is up to the host. Swap in a different implementation in `packages/dsh-plugin/src/crisis-notify.ts`.
- `emergencyContact` belongs in a private preset only. It never appears in code or logs.
- The default resources are mainland China's 12356 / 110 / 120. For other regions, edit the resource line in `packages/memory/src/crisis.ts`.
- Rehearse in a shadow session before going live. Send three messages at different levels and check that her replies give resources, give no methods and don't lecture; that the emergency contact is notified; and that the caution period ends on schedule.

## 7. Backups before upgrading, and rollback

**Before upgrading:**

1. Back up the memory store: copy `memory.db` with DSH stopped, or use SQLite's online backup. The 0.7 migration script makes one automatically. New plugin versions may upgrade the search index (for example, 0.6 added the synonym-key column and rebuilt the full-text index), and the index does not revert on rollback, so a separate backup matters.
2. Back up the plugin directory (`node_modules/dsh-her-life` under the profile) and the preset.
3. Write down the current version and switch combination.

**Rolling back:**

1. Put the old plugin directory back and restart DSH. The old code ignores the new columns and tables, and opens the same store normally.
2. If you need to roll back the data too, stop DSH and replace `memory.db` with the backup.
3. Confirm with `MemoryStore.verifyIntegrity()` (or the migration script's integrity check) that every row's content hash matches.

## 8. Security recommendations

These are general principles. Adapt the specifics to your environment.

- **Keep the real key out of the agent process.** Run a small key gateway (a reverse proxy) on the host. The real model key lives only in the gateway, and DSH and the nightly review get a local token. The gateway enforces daily budgets, rate limits and a model allow-list, and trips a breaker if things run away.
- **Outbound allow-list.** The OS user that runs DSH should only reach the addresses it needs (the gateway, the messaging platform), with all other outbound traffic denied by default. Get this in place before you ever let her browse the web.
- **Least privilege.** Use a dedicated OS user. The seed is root-owned and read-only for her; the life directory is 0700 and `memory.db` is 0600; system directories are read-only. Use `blockTools` to deny host tools this session shouldn't touch (the plugin's pre-execution guard is a second line).
- **Administration goes through an admin channel, not chat.** Configuration, allow-lists and budgets are changed on the server by an administrator. Nobody in chat, the owner included, can get her to change them.
- **Encrypt memory backups.** Each night, back up the life directory (`memory.db` via SQLite online backup, plus diaries and self.md), encrypt it, store it off the host, and rehearse restores regularly.
- **Keep secrets out of diagnostics.** Deployment and diagnostic scripts should print only yes/no, numbers and status, never tokens, contact details or conversation text. Run `npm run scan` before committing.
