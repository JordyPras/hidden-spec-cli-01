# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JordyPras/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JordyPras/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one dependency-free command-line tool that applies AI-written edits in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text files, all or nothing.

## Run it

```sh
node main.ts [options] [PATCH]
```

`mend` reads a patch in one of four formats (detected automatically, or forced with `--format=`), finds the lines each edit names — exactly, or with trailing whitespace or indentation ignored when the model drifted them — and writes every change or none. `--check` reports what would change without writing anything, and `--strict` matches lines exactly. `SPEC.md` is the whole contract: the four formats, the three matching tiers, all-or-nothing writes, and the exact exit codes and output.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
