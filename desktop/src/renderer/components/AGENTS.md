# Renderer Components

## Task Markdown Editor

Task markdown is the source of truth. The raw `.md` file must stay readable,
grep-able, editable, and unsurprising for agents and humans outside the UI.

The formatted editor is a friendly human layer over markdown, not a separate
document model. Raw mode is first-class, not a fallback.

Preserve meaningful markdown semantics. Only normalize details that do not
change the document's meaning.

Optimize for both audiences: agents reasoning through raw files and humans
reading or editing through the UI. Do not meaningfully compromise either side.
