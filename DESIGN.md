# Design of this extension

The diagram below presents a high-level overview of the design of this extension.

```
                                Client                           Server                       F* processes
                       vscode-languageclient/node        vscode-languageserver/node             Native F*
                                                                                              ___________
  .---------.  events      .---------------.               .---------------.                 |_fstar.exe_|_   
  | editor  | -----------> |  extension.ts | -----LSP--->  |   server.ts   | ---fstar-ide--->  |_fstar.exe_|_         
  |_________| <----------- |_______________| <----LSP----  |_______________| <--fstar-ide------- |_fstar.exe_|_
              diagnostics                                                                          |_fstar.exe_| 
```

## Workflow

* The editor starts the client on an initialization event

* The client launches a language server, implemented in server.ts, executing on the nodejs server runtime.
  The client and server interact using Language Server Protocol (LSP).
  
* For each F* document opened by the editor, the server launches multiple fstar.exe processes.
  F* implements its own IDE protocol, designed first for use by F*'s emacs mode, fstar-mode.el.
  We reuse that protocol to communicate between server.ts and fstar.exe,
  communicating using JSON-formatted IDE messages over stdin/stdout.

This three layered design has the following benefits:

* The asynchrony and server aspects to handle multiple document sessions are handled in server.ts,
  using existing nodejs libraries rather than having to build a LSP server in F* itself.

* Every document has its own F* process, providing isolation

* We reuse the IDE protocol, which has been used and tested extensively over several years in the
  context of fstar-mode.el.

On the downside, our use of the custom IDE protocol means that adapting this extension for use in other
LSP-capable editors would require also re-writing server.ts, rather than being able to use fstar.exe
out of the box.

# Main event handlers

## Standard LSP Events

### onInitialize

Raised once, when the extension is initialized by the client.

The servers reads the workspace configuration (.fst.config.json) if any,
and sets up its state.

* `const documentStates: Map<string, IDEState>`: A map from the URI of each open document
   to the IDE state for it.

* `const workspaceConfigs: Map<string, FStarConfig>`: A parsed .fst.config.json file, if any,
   for all open workspace folders.


### onDidOpen

server.ts launches two F* processes per open document:

* `fstar_ide`: This is a process used to handle verification requests on the document.

* `fstar_lax_ide`: This is used to handle on-the-fly checking, symbol resolution etc.
   Fragments of a document are only lax-checked by this F* process.

### onDidChangeContent

`fstar_lax_ide` is called to check the suffix of the document that has changed

### onDidSave

`fstar_ide` is called to fully check the suffix of the document that has not yet been checked.

### onHover

`fstar_lax_ide` is called to resolve the type of the symbol under the cursor.

### onDefinition

`fstar_lax_ide` is called to resolve the definition of the symbol under the cursor.

### onDocumentRangeFormatting

Re-formatting a document selection is a synchronous event in LSP.
However, interactions with `fstar_lax_ide` and `fstar_ide` are asychronous.

Since re-formatting is a purely syntactic task and does not rely on any specific
F* typechecker state, for this event, we spawn a new process fstar.exe synchronously, 
and send it the `format` message with the content of the current selection, returning
its result as the reformatted content.

### onCompletion

The `server.ts` sends an `autocomplete` IDE request to fstar_lax_ide.

## Custom events

### `fstar-vscode-extension/verify-to-position`

The user can trigger this event by using `Ctrl+.`

server.ts sends a request to `fstar_ide` to check the document up
to the current cursor position.

### `fstar-vscode-extension/lax-to-position`

The user can trigger this event by using `Ctrl+Shift+.`

server.ts sends a request to `fstar_ide` to lax check the document up
to the current cursor position.

### `fstar-vscode-extension/restart`

The user can trigger this event by using `Ctrl+; Ctrl+.`

server.ts kills both the `fstar_ide` and `fstar_lax_ide` processes,
clears any other document state, and then restarts the proceses.

This is useful to rewind its state to the top of the current document
and reload any dependences.

### `fstar-vscode-extension/text-doc-changed`

When the document changes, the client forwards this event to the server, including
the first position in the document of the change. This position is not available in 
the `onDidChangeContent` LSP event, so we have a custom event for it.

To handle this event, server.ts sends a `cancel p` message to `fstar_ide`, where `p`
is the position of the change. In response, in `fstar_ide` will cancel all pending
requests to check fragments of the document whose position is at `p` or beyond.

## Events from server.ts to extension.ts

In addition to standard LSP diagnostics, hover events, definitions, completions etc., 
we have the following four custom messages send from server.ts to client.ts

* `fstar-vscode-extension/statusStarted`: A message to show which fragment of the document
   is currently being processed by `fstar_ide`, used to show hourglass icons.

* `fstar-vscode-extension/statusOk`: A message to show which fragment of the document was checked,
   either fully checked or lax checked, showing either checkmarks or question marks
   in the gutter.
		
* `fstar-vscode-extension/statusClear`: A message to clear all gutter icons.

* `fstar-vscode-extension/statusFailed`: A message to indicate that checking has failed on a fragment,
   which causes the extension to clear any hourglass icons that remain.
