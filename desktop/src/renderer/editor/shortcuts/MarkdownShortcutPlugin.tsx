/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// Vendored from @lexical/react@0.35.0 (LexicalMarkdownShortcutPlugin) — a thin
// React wrapper that registers the shortcut engine on mount. Copied here (rather
// than imported) so it wires up OUR vendored `registerMarkdownShortcuts` instead
// of the @lexical/markdown one, which drags @lexical/code/prismjs into the
// bundle. Unlike upstream this takes no default transformer set (the upstream
// default is built from @lexical/markdown's TRANSFORMERS, which includes the
// CODE transformer and thus @lexical/code); every call site passes an explicit
// `transformers` list (see ../config.ts's MARKDOWN_TRANSFORMERS), so the prop is
// required.
import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

import { registerMarkdownShortcuts } from "./registerMarkdownShortcuts";
import type { Transformer } from "./types";

export function MarkdownShortcutPlugin({
  transformers,
}: {
  transformers: Array<Transformer>;
}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return registerMarkdownShortcuts(editor, transformers);
  }, [editor, transformers]);
  return null;
}
