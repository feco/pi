---
name: devvm
description: Per-project isolated development VMs on this Mac (devvm, Lima, the `dev` command). Use before creating, opening, syncing, updating, or deleting a project VM, changing the VM image, tools, or isolation rules, or explaining how project VMs work.
---

1. Read `/Users/work/devvm/README.md` fully. Then read the linked document the task needs: how-to guides for tasks, reference for commands, settings, and copy rules, explanation for design decisions and known gaps.
2. Treat those documents and the code in `/Users/work/devvm` as authoritative. When a document and the code disagree, follow the code and report the mismatch.
3. Locate the owning file before a change: `bin/dev`, `bin/dev-sync`, `nixos/base.nix`, `home/default.nix`, or `lima/devvm.yaml`.
4. When a change alters devvm behavior, update the documents that describe it in the same change.

Done when the owning file and the documented commands for the task are identified, and every behavior change has a matching documentation update.
