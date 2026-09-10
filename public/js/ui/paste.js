const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

// One literal paste transaction: normalize line endings and prevent pasted terminal controls from
// ending bracketed-paste mode early. The user presses Enter separately when they want to submit.
export function pastePayload(value) {
  let text = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  let previous;
  do {
    previous = text;
    text = text.split(BP_START).join("").split(BP_END).join("");
  } while (text !== previous);
  return BP_START + text + BP_END;
}
