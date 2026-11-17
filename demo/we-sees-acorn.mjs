// A generic AD4M app view of a mounted perspective: read what is there and
// edit it through the built-in abstract classes alone —
// ad4m://TextContent { text } and ad4m://Container { children }. The script
// knows nothing about which concrete language mounted the data; the mount
// decides which classes conform (the abstract read is their union) and a
// write through the abstract class runs the concrete class's own setter.
//
// usage: node demo/we-sees-acorn.mjs <perspective uuid> [--rename <instance url> <new text>]
import { rpc, close } from "../rig/ad4m.mjs";
import { basename } from "node:path";

const TEXT_CONTENT = "ad4m://TextContent";
const CONTAINER = "ad4m://Container";

// The usage line names the script by its own file name, so it never needs
// the name in a string literal.
const USAGE = `usage: node demo/${basename(process.argv[1])} <perspective uuid> [--rename <instance url> <new text>]`;

const [uuid, ...rest] = process.argv.slice(2);
if (!uuid) {
  console.error(USAGE);
  process.exit(1);
}

// modelQuery params are snake_case on the wire (PerspectiveModelQueryParams).
async function modelQuery(className) {
  const res = await rpc("perspective.modelQuery", {
    uuid,
    class_name: className,
    query_json: "{}",
  });
  const parsed = typeof res === "string" ? JSON.parse(res) : res;
  return parsed?.instances ?? [];
}

const printText = (row) => console.log(`${row.id}\t${row.text ?? ""}`);

try {
  console.log(`== ${TEXT_CONTENT} ==`);
  for (const row of await modelQuery(TEXT_CONTENT)) printText(row);

  console.log(`== ${CONTAINER} ==`);
  for (const row of await modelQuery(CONTAINER)) {
    console.log(`${row.id}\tchildren: ${JSON.stringify(row.children ?? [])}`);
  }

  if (rest[0] === "--rename") {
    const [instanceUrl, newText] = rest.slice(1);
    if (!instanceUrl || newText === undefined) {
      console.error("--rename needs <instance url> and <new text>");
      process.exit(1);
    }
    // The abstract name carries the intent ("set the text"); the mounted
    // shape's alias maps it onto the concrete property and its setter.
    await rpc("perspective.updateSubject", {
      uuid,
      subjectClass: TEXT_CONTENT,
      expressionAddress: instanceUrl,
      values: JSON.stringify({ text: newText }),
    });
    const row = (await modelQuery(TEXT_CONTENT)).find(
      (r) => r.id === instanceUrl
    );
    if (!row) {
      console.error(`${instanceUrl} is not a ${TEXT_CONTENT} row after the rename`);
      process.exit(1);
    }
    printText(row);
  } else if (rest.length) {
    console.error(`unknown argument ${rest[0]} (want --rename)`);
    process.exit(1);
  }
} finally {
  close();
}
