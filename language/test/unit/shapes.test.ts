import test from "node:test";
import assert from "node:assert/strict";
import { mountShapesFor, CLASS_NAMES } from "../../src/shapes";

const STUB_LANG = "QmzStubAddress";
const RESERVED = ["id", "baseExpression", "createdAt", "updatedAt", "author", "timestamp", "__links"];

const { version, shapes } = mountShapesFor(STUB_LANG);

test("mountShapes returns the nine Acorn classes", () => {
  // v2 adds AcornMember.sameAs (B5)
  assert.equal(version, "2");
  assert.equal(shapes.length, 9);
  assert.deepEqual(
    shapes.map((s) => s.name),
    [...CLASS_NAMES]
  );
  for (const s of shapes) {
    assert.ok(s.name.startsWith("Acorn"), s.name);
    assert.equal(
      s.shape.target_class,
      `acorn://${s.name.slice("Acorn".length)}`,
      `${s.name} target_class`
    );
  }
});

test("every shape has its rdf://type flag property", () => {
  for (const s of shapes) {
    const flag = s.shape.properties.find((p: any) => p.name === "type");
    assert.ok(flag, `${s.name} has no type flag`);
    assert.equal(flag.path, "rdf://type");
    assert.equal(flag.has_value, s.shape.target_class);
    assert.equal(flag.min_count, 1);
    assert.equal(flag.max_count, 1);
  }
});

test("no property uses a reserved name", () => {
  for (const s of shapes) {
    for (const p of s.shape.properties) {
      assert.ok(
        !RESERVED.includes(p.name),
        `${s.name}.${p.name} collides with a reserved property name`
      );
    }
  }
});

test("every constructor source is <lang>://class/<ClassName>", () => {
  for (const s of shapes) {
    if (s.name === "AcornMember") {
      assert.deepEqual(s.shape.constructor_actions ?? [], []);
      continue;
    }
    const ctor = s.shape.constructor_actions;
    assert.ok(Array.isArray(ctor) && ctor.length === 1, `${s.name} constructor`);
    assert.equal(ctor[0].action, "call");
    assert.equal(ctor[0].predicate, "create");
    assert.equal(ctor[0].target, "{}");
    assert.ok(
      ctor[0].source.startsWith(`${STUB_LANG}://class/`),
      `${s.name} constructor source ${ctor[0].source}`
    );
    assert.equal(ctor[0].source, `${STUB_LANG}://class/${s.name}`);
  }
});

test("destructors exist except on AcornMember, AcornProjectMeta, AcornProfile", () => {
  const noDelete = new Set(["AcornMember", "AcornProjectMeta", "AcornProfile"]);
  for (const s of shapes) {
    const dtor = s.shape.destructor_actions ?? [];
    if (noDelete.has(s.name)) {
      assert.deepEqual(dtor, [], `${s.name} should have no destructor`);
    } else {
      assert.equal(dtor.length, 1, `${s.name} destructor`);
      assert.deepEqual(dtor[0], {
        action: "call",
        source: "this",
        predicate: "delete",
        target: "{}",
      });
    }
  }
});

test("read-only properties carry no setter; writable ones do", () => {
  const READ_ONLY = new Set([
    "type", "entryHash", "recordCreatedAt", "recordUpdatedAt",
    "creator", "editor", "agent", "agentPubKey", "sameAs",
    "timestampCreated", "timestampUpdated", "unixTimestamp", "createdAtTime",
    "isImported", "isMigrated",
  ]);
  for (const s of shapes) {
    for (const p of s.shape.properties) {
      const setters = p.setter ?? [];
      if (READ_ONLY.has(p.name) || (s.name === "AcornOutcome" && (p.name === "parent" || p.name === "children"))) {
        assert.equal(setters.length, 0, `${s.name}.${p.name} should be read-only`);
      } else {
        assert.deepEqual(setters, [
          { action: "call", source: "this", predicate: "update", target: "{}" },
        ], `${s.name}.${p.name} setter`);
      }
    }
  }
});

test("AcornProjectMeta has no passphrase property", () => {
  const meta = shapes.find((s) => s.name === "AcornProjectMeta")!;
  assert.ok(!meta.shape.properties.some((p: any) => p.name === "passphrase"));
});

test("aliases: content→TextContent.text, children→Container.children", () => {
  const outcome = shapes.find((s) => s.name === "AcornOutcome")!;
  const content = outcome.shape.properties.find((p: any) => p.name === "content");
  assert.deepEqual(content.alias, { TextContent: "text" });
  const children = outcome.shape.properties.find((p: any) => p.name === "children");
  assert.deepEqual(children.alias, { Container: "children" });
  const comment = shapes.find((s) => s.name === "AcornOutcomeComment")!;
  const cContent = comment.shape.properties.find((p: any) => p.name === "content");
  assert.deepEqual(cContent.alias, { TextContent: "text" });
});
