// The clipboard for the key chip's test: the real module writes to
// navigator.clipboard, which a node test does not have. `copyText` is the
// component's import; a test sets the behavior it needs (accept or refuse).
let copy = () => Promise.resolve();
export function copyText(text) {
  return copy(text);
}
export function setCopy(next) {
  copy = next;
}
