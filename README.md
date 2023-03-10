# STILL VERY MUCH A WORK IN PROGRESS: NOT INTENDED FOR USE YET!

# F* VS Code Assistant

This VS Code extension provides support for interactively editing and
checking F* files incrementally.

It is adapted from the lsp-sample provided by VS Code:
https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample

The vsfstar extension was also a source of inspiration and initial guidance:
https://github.com/artagnon/vsfstar

## Running it

- Run `npm install` in this folder. This installs all necessary npm
  modules in both the client and server folder

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

  - You should see some basic syntax highlighting
  - And, as you type, you should see F* checking your code and providing diagnostics interactively
