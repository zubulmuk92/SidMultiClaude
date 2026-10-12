// test/unit/web-chat/_stub-dompurify.mjs — Node-only stand-in for DOMPurify (it needs a DOM). The unit tests never render
// markdown; sanitizing is tested in Edge by browser.test.ts (11 XSS payloads under Trusted Types).
const DOMPurify = {
  addHook() {},
  sanitize() { throw new Error('DOMPurify stub: markdown is rendered in the browser tests only'); },
};
export default DOMPurify;
