// Real React/Radix DOM with explicitly supplied synthetic service boundaries.
// No browser, cloud session or network; layout and deployed acceptance separate.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { JSDOM } from "jsdom";
export function uiHarness(stubs) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const name of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "NodeFilter",
    "MutationObserver",
    "CustomEvent",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "DocumentFragment",
    "HTMLSelectElement",
  ])
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const require = createRequire(import.meta.url),
    React = require("react"),
    { act } = React,
    { createRoot } = require("react-dom/client");
  const queries = require("@testing-library/dom"),
    userEvent = require("@testing-library/user-event").default,
    cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    const localRequire = (id) => {
      if (stubs[id]) return stubs[id];
      if (id.startsWith("@/") || id.startsWith(".")) {
        const base = id.startsWith("@/")
          ? path.resolve("src", id.slice(2))
          : path.resolve(path.dirname(file), id);
        const resolved = [
          base,
          base + ".ts",
          base + ".tsx",
          path.join(base, "index.ts"),
          path.join(base, "index.tsx"),
        ].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        if (!resolved) throw Error("Unresolved UI fixture import " + id);
        return load(resolved);
      }
      return require(id);
    };
    vm.runInThisContext(`(function(exports,require){${source}\n})`, { filename: file })(
      exports,
      localRequire,
    );
    return exports;
  }
  let root;
  async function render(Component) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(React.createElement(Component)));
    return userEvent.setup({ document });
  }
  const perform = async (fn) => {
    await act(async () => {
      await fn();
    });
  };
  async function cleanup() {
    if (root) await act(async () => root.unmount());
    root = null;
    document.body.innerHTML = "";
  }
  return { React, load, render, perform, cleanup, ...queries };
}
