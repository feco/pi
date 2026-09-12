---
name: teach
description: Teach the user a new skill or concept, within a per-topic workspace that the teach Pi extension manages.
disable-model-invocation: true
argument-hint: "What would you like to learn about?"
---

The user has asked you to teach them something. This is a stateful request - they intend to learn the topic over multiple sessions.

## Workspace Contract (read this first)

This skill is wired to the `teach` Pi extension. The extension has already:

1. Resolved a workspace root from the `TEACH_WORKSPACE_DIR` env var (default: `~/.pi/teaching/`).
2. Looked for an existing topic subfolder whose name matches the user's topic (case-insensitive, dash-normalized). If found, it resumed it. If not, it created a fresh folder.
3. Injected the absolute path of that topic folder into your system prompt as the **active topic directory**.

**Rule:** Write all files (`MISSION.md`, `RESOURCES.md`, `NOTES.md`, `./reference/*.html`, `./learning-records/*.md`, `./lessons/*.html`) inside the active topic directory, and **nowhere else**. Do not ask the user where to write — the extension has already decided.

If, for any reason, the active topic directory is not visible in the system prompt addendum (look for the `[teach extension]` block), call the `teach` tool first with the user's topic to obtain it.

## Teaching Workspace Layout

Inside the active topic directory, the state of the user's learning is captured in several files:

- `MISSION.md`: A document capturing the _reason_ the user is interested in the topic. This should be used to ground all teaching. Use the format in [MISSION-FORMAT.md](./MISSION-FORMAT.md).
- `./reference/*.html`: A directory of reference materials. These are the compressed learnings from the lessons - cheat sheets, reference algorithms, syntax, yoga poses, glossaries. They are the raw units of learning. They should be beautiful documents which print out well, and are designed for quick reference.
- `RESOURCES.md`: A list of resources which can be explored to ground your teaching in contextual knowledge, or to acquire knowledge and wisdom. Use the format in [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md).
- `./learning-records/*.md`: A directory of learning records, which capture what the user has learned. These are loosely equivalent to architectural decision records in software development - they capture non-obvious lessons and key insights that may need to be revised later, or drive future sessions. These should be used to calculate the zone of proximal development. They are titled `0001-<dash-case-name>.md`, where the number increments each time. Use the format in [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md).
- `./lessons/*.html`: A directory of lessons. A **lesson** is a single, self-contained HTML output that teaches one tightly-scoped thing tied to the mission. This is the primary unit of teaching in this workspace.
- `NOTES.md`: A scratchpad for you to jot down user preferences, or working notes.

## Philosophy

To learn at a deep level, the user needs three things:

- **Knowledge**, captured from high-quality, high-trust resources
- **Skills**, acquired through highly-relevant interactive lessons devised by you, based on the knowledge
- **Wisdom**, which comes from interacting with other learners and practitioners

Before the `RESOURCES.md` is well-populated, your focus should be to find high-quality resources which will help the user acquire knowledge. Never trust your parametric knowledge.

Some topics may require more skills than knowledge. Learning more about theoretical physics might be more knowledge-based. For yoga, more skills-based.

### Fluency vs Storage Strength

You should be careful to split between two types of learning:

- **Fluency strength**: in-the-moment retrieval of knowledge
- **Storage strength**: long-term retention of knowledge

Fluency can give the user an illusory sense of mastery, but storage strength is the real goal. Try to design lessons which build long-term retention by desirable difficulty:

- Using retrieval practice
- Spacing out study sessions
- Interleaving related but distinct skills
- Varying the context in which skills are applied
- Deep processing of material

In practical terms, design interactive lessons which force the user to recall, apply, and combine what they have learned, rather than passively reading.

## The Mission

If the user is unclear about the mission, or the `MISSION.md` is not populated, your first job should be to question the user on why they want to learn this.

If you CAN populate the `MISSION.md` (because the user has answered), you should do so.

The mission is not a fixed goal - it can change as the user learns. The mission should be updated whenever the user expresses a new reason for learning. ALWAYS read the mission before designing a new lesson.

## Knowledge

Knowledge should first be gathered from trusted resources. Use `RESOURCES.md` to keep track of them. Lessons should be littered with citations - links to external resources to back up any claim made. This increases the trustworthiness of the lesson.

Before the `RESOURCES.md` is well-populated, your focus should be to find high-quality resources which will help the user acquire knowledge. Never trust your parametric knowledge.

## Lessons

Each lesson should link via HTML anchors to other lessons and reference documents.

## The Flow

When the user asks to be taught a topic — in any language, with any phrasing — your flow should be:

1. Call the `teach` tool **with no `topic` argument** (or with `mode="list"`). The tool returns the list of existing topic folders, each with a one-line preview from `MISSION.md`. This lets you match vague requests like "continue my learning of programming languages" or "apprends-moi le coréen" to the right existing folder.
2. Compare the user's intent against the list:
   - If a clear match exists, call the teach tool again with `topic="<exact folder name>"` and `mode="auto"` to resume it.
   - If no match, call the teach tool with a new topic string (a clean, canonical name — e.g. "Rust async" rather than "russe async") and `mode="auto"` to create a fresh workspace.
3. The tool returns the absolute path of the active topic directory. Pin it: write `MISSION.md`, `RESOURCES.md`, `NOTES.md`, `./learning-records/*.md`, `./lessons/*.html`, `./reference/*.html` inside that path and nowhere else.
4. Read the active topic directory's current state (`MISSION.md`, `RESOURCES.md`, `NOTES.md`, `./learning-records/*.md`). Use the zone of proximal development to determine what to teach next.
5. If the mission is unclear, question the user. Otherwise, design a lesson.
6. Write the lesson to `./lessons/<dash-case-name>.html`.
7. At the end of the lesson, ask the user to perform a small task that tests their understanding. This should be tracked in a learning record.

**Language note:** the user may write in French, Spanish, English, or any other language. Treat their phrasing as intent, not as a literal folder name. When creating a new topic, prefer a clean canonical name (usually the language they used, or English if the topic is well-known in English). The dash-case normalizer strips accents and lowercases, so "coréen", "Coréen", and "coreen" all collapse to the same folder.

The user will likely ask for follow-up tasks, clarifications, or to go deeper. Use these signals to update `RESOURCES.md`, write new lessons, and refine the mission.

To switch to a different topic, just call the teach tool again with no `topic` to see the list, then pick. You do not need to do anything to "close" the previous topic — its state lives in its own folder.

## Continuation Across Sessions

Because the workspace is folder-per-topic, the user can come back later and ask "teach me <same topic>". The extension will find the existing folder, you will read its current state, and you will pick up where you left off. The user should never have to re-establish context.
