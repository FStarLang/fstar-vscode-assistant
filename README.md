# F* VS Code Assistant

This VS Code extension provides support for interactively editing and
checking F* files incrementally.

It is adapted from the lsp-sample provided by VS Code:
https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample

The vsfstar extension was also a source of inspiration and initial guidance:
https://github.com/artagnon/vsfstar

## Installation

An initial test release v0.0.1 is provided as a .vsix package in the Releases section. 

In VSCode, click on extensions menu on the right, and then choose "Install from VSIX"

You need to have a working F* installation, where `fstar.exe` is in your path
and `fstar.exe --ide A.fst` should print the following protocol-info:

```
{"kind":"protocol-info","version":2,"features":["autocomplete","autocomplete/context","compute","compute/reify","compute/pure-subterms","describe-protocol","describe-repl","exit","lookup","lookup/context","lookup/documentation","lookup/definition","peek","pop","push","search","segment","vfs-add","tactic-ranges","interrupt","progress","full-buffer","format","cancel"]}
```

## Features and basic usage guide

### Basic syntax highlighting

The extensions highlights all keywords in an F* source file, triggered on .fst and fsti files

### Incremental checking

The main feature offered by this extension is to incrementally check the contents of an F* document.

For each line of the document, F* indicates the checking status with an icon in the gutter
on the left of the editor pane.

There are three kinds of gutter icons:

1. A check mark: This line was fully checked

2. An hourglass: This line is currently being processed by F*

3. A question mark: This line was processed by F*, but the user instructed 
   F* to skip proving it (it was checked according to F*'s lax mode)

* Check file on opening: When a file is opened, F* attempts to check the
  entire contents of the file, stopping at the first error. You should see check marks
  in the gutter for the prefix of the file that was checked.

* Check to current cursor: The key-binding `Ctrl+.` advances the checker up to the
  F* definition that encloses the current cursor position. 

* Lax check to current cursor: The key-binding `Ctrl+Shift+.` advances the checker by
  lax-checking the document up to the F* definition enclosing the current cursor position.
  This is useful if you want to quickly advance the checker past a chunk of document which
  might otherwise take a long time to check.

* Reload dependence: The key-binding `Ctrl+; Ctrl+.` rewinds the checker to the top of the
  document and reloads any dependences that may have changed.

* Check file on save: When the file is saved, the checker is advances in full checking mode
  to the end of the document. This is equivalent to doing `Ctrl+.` on the last line of the document.

### Diagnostic squigglies for errors and warnings

Any errors or warnings reported by the checker appear in the Problems pane and are also
highlighted with "squigglies" in the document.

### Hover for the type of a symbol under the cursor and jump to definitions

You can hover on an identifer to see its type.

Note, the first time you hover on an identifer, you may see a message "Loading symbol: ..."

If F* can resolve the symbol, the next time you hover on it, you should see its fully qualified name and type.

You can also jump to the definition, using the menu option or by pressing F12.

### Proof state dumps for tactic execution

If you are using tactics, you can hover on tactic line to see the last proof state dumped at that line

### Format document and format selection

You can select a fragment and use the menu option to ask F* to format it.
You can also format the entire document using F*'s pretty printer.

Note: The formatting feature needs to be improving F*'s pretty printer. It doesn't always produce
the nicest looking code. 

### Workspace folders

If you have a .fst.config.json file in a folder, you can open the folder as a workspace
and all F* files in that workspace using the .fst.config.json file as the configuration
for launching `fstar.exe`. Here is a sample .fst.config.json file:

```
{ "fstar_exe":"fstar.exe",
  "options":["--cache_dir", ".cache.boot", "--no_location_info", "--warn_error", "-271-272-241-319-274"],
  "include_dirs":["../ulib", "basic", "basic/boot", "extraction", "fstar", "parser", "prettyprint", "prettyprint/boot", "reflection", "smtencoding", "syntax", "tactics", "tosyntax", "typechecker", "tests", "tests/boot"] }
```

* The field `"fstar_exe"` contains the path to the `fstar.exe` executable.
* The `"options"` field contains the command line options you want to pass to `fstar_exe`
* The `"include_dirs"` field contains all include directories to pass to `fstar_exe`,
  relative to the workspace root folder.

## Planned features

This extensions does not yet support the following features, though support is expected soon.

* Completions
* Evaluating code snippets on F*'s reduction machinery
* Types of sub-terms
* Tactic proof state dumps when there is more than one dump associated with a line, e.g., in loops

## Running it in development mode

- Run `npm install` in this folder. This installs all necessary npm
  modules in both the client and server folder

- Make sure to have a working fstar.exe in your path

- Open VS Code on this folder.

- Press Ctrl+Shift+B to start compiling the client and server in
  [watch
  mode](https://code.visualstudio.com/docs/editor/tasks#:~:text=The%20first%20entry%20executes,the%20HelloWorld.js%20file.).

- Switch to the Run and Debug View in the Sidebar (Ctrl+Shift+D).

- Select `Launch Client` from the drop down (if it is not already).

- Press ▷ to run the launch config (F5).

- In the [Extension Development
  Host](https://code.visualstudio.com/api/get-started/your-first-extension#:~:text=Then%2C%20inside%20the%20editor%2C%20press%20F5.%20This%20will%20compile%20and%20run%20the%20extension%20in%20a%20new%20Extension%20Development%20Host%20window.)
  instance of VSCode, open a document with a `.fst` or `.fsti` filename extension.

  - You should see some syntax highlighting
  - And, as you type, you should see F* checking your code and providing diagnostics interactively