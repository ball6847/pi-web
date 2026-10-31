import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createComposerFocus } = await jiti.import("./composer-focus.ts");

/** A frame scheduler the test drives by hand. */
function frames() {
  const queue = [];
  return {
    schedule: (callback) => queue.push(callback),
    run() {
      const pending = queue.splice(0);
      for (const callback of pending) callback();
    },
    get length() { return queue.length; },
  };
}

/** A composer that reports whether it holds the caret. */
function composer() {
  const state = { focused: false, calls: 0 };
  return {
    state,
    target: {
      focus() {
        state.calls += 1;
        state.focused = true;
      },
      hasFocus() { return state.focused; },
    },
  };
}

test("the request puts the caret in the composer", () => {
  const clock = frames();
  const field = composer();
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => null,
  });

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 1);
  assert.equal(field.state.focused, true);
});

test("the request waits for the composer to render", () => {
  const clock = frames();
  const field = composer();
  let mounted = false;
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => (mounted ? field.target : null),
    schedule: clock.schedule,
    getActiveElement: () => null,
  });

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 0, "the composer is not there yet");
  mounted = true;
  clock.run();
  assert.equal(field.state.calls, 1, "the request takes the caret as soon as it can");
});

test("a phone is left alone: its keyboard would cover the chat", () => {
  const clock = frames();
  const field = composer();
  const focus = createComposerFocus({
    isMobile: () => true,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => null,
  });

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 0);
  assert.equal(clock.length, 0, "a phone makes no request at all");
});

test("a dialog over the page keeps the focus it has", () => {
  const clock = frames();
  const field = composer();
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => ({ closest: (selector) => selector === "[aria-modal='true']" ? {} : null }),
  });

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 0);
});

test("a caret that is already in the composer is not moved", () => {
  const clock = frames();
  const field = composer();
  field.state.focused = true;
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => null,
  });

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 0, "the caret stays where the user put it");
});

test("a hidden composer is focused again on the next frame", () => {
  // The board covers the chat (`display: none`): a focus on a hidden field
  // does nothing, so the request tries again until the chat is back.
  const clock = frames();
  const field = composer();
  let visible = false;
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => null,
  });
  field.target.focus = () => {
    field.state.calls += 1;
    if (visible) field.state.focused = true;
  };

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 1);
  assert.equal(field.state.focused, false);
  visible = true;
  clock.run();
  assert.equal(field.state.focused, true);
});

test("a newer request wins over an older one", () => {
  const clock = frames();
  const field = composer();
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => null,
  });

  focus.request();
  focus.request();
  clock.run();
  assert.equal(field.state.calls, 1, "the second pick is the one that has the caret");
});

test("the request gives up when the composer never comes", () => {
  const clock = frames();
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => null,
    schedule: clock.schedule,
    getActiveElement: () => null,
    maxFrames: 3,
  });

  focus.request();
  for (let i = 0; i < 10; i += 1) clock.run();
  assert.equal(clock.length, 0, "the request stops after its budget");
});

test("a cancelled request does not take the caret", () => {
  const clock = frames();
  const field = composer();
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => null,
  });

  focus.request();
  focus.cancel();
  clock.run();
  assert.equal(field.state.calls, 0);
});

test("a field the user moved to while the request waited keeps its caret", () => {
  const clock = frames();
  const field = composer();
  let active = { tagName: "A", closest: () => null };
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => active,
  });

  focus.request();
  // The user clicks the sidebar's search field and types while the composer
  // is still rendering: that caret is theirs.
  active = { tagName: "INPUT", closest: () => null };
  clock.run();
  assert.equal(field.state.calls, 0);
});

test("the field the request was made in does not keep the caret", () => {
  // The session was picked from the sidebar's search results (Enter): the
  // search field had the caret when the request was made, and the composer
  // takes it.
  const clock = frames();
  const field = composer();
  const active = { tagName: "INPUT", closest: () => null };
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => active,
  });

  focus.request();
  clock.run();
  assert.equal(field.state.calls, 1);
});

test("an explicit request takes the caret from a field", () => {
  const clock = frames();
  const field = composer();
  let active = { tagName: "A", closest: () => null };
  const focus = createComposerFocus({
    isMobile: () => false,
    getTarget: () => field.target,
    schedule: clock.schedule,
    getActiveElement: () => active,
  });

  focus.request();
  active = { tagName: "INPUT", closest: () => null };
  clock.run();
  assert.equal(field.state.calls, 0);

  focus.request({ force: true });
  clock.run();
  assert.equal(field.state.calls, 1, "the chord takes the caret wherever it is");
});
