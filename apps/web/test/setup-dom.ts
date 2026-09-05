import { afterAll } from "bun:test";
import { Window } from "mad-dom";

const dom = new Window({ url: "http://localhost:5173" });
// mad-dom implements iframe elements but does not expose this constructor on
// Window yet. React reads it when inspecting the active element. Reuse the
// actual implementation; this adapter does not emulate iframe navigation.
Object.defineProperty(dom, "HTMLIFrameElement", {
  configurable: true,
  value: dom.document.createElement("iframe").constructor,
});
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  MutationObserver: dom.MutationObserver,
  // mad-dom has no layout viewport. Scroll behavior needs browser tests.
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map<string, PropertyDescriptor | undefined>();

// Install only DOM globals. Keep Bun's timers, fetch and process untouched.
for (const [name, value] of Object.entries(globals)) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

afterAll(async () => {
  try {
    await dom.happyDOM.close();
    dom.destroy();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
