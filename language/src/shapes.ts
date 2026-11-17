// The nine Acorn classes as SHACL shape JSON (design §4.1, corrected for the
// reserved property names — Corrections 13/6). `mountShapesFor(lang)` is pure:
// the language's own address only shows up in the constructor's call source.
//
// Property kinds:
//   "value" — literal (string/number/bool/JSON string); default
//   "ref"   — an IRI target: `<lang>://<ActionHashB64>` or a `did:key` IRI
// Read-only properties carry no setter; writable ones get the call setter B3
// implements (`update` on `this`).

export const SHAPES_VERSION = "1";

export const CLASS_NAMES = [
  "AcornOutcome",
  "AcornConnection",
  "AcornEntryPoint",
  "AcornOutcomeComment",
  "AcornOutcomeMember",
  "AcornTag",
  "AcornProjectMeta",
  "AcornMember",
  "AcornProfile",
] as const;

export type ClassName = (typeof CLASS_NAMES)[number];

interface Prop {
  name: string;
  kind?: "value" | "ref";
  collection?: boolean;
  ro?: boolean;
  alias?: Record<string, string>;
}

interface ClassDef {
  props: Prop[];
  create: boolean;
  delete: boolean;
}

const UPDATE_SETTER = [
  { action: "call", source: "this", predicate: "update", target: "{}" },
];

// Every class's trailing read-only metadata from the WireRecord
// (`createdAt`/`updatedAt` are reserved names — Correction 13).
const WIRE_PROPS: Prop[] = [
  { name: "entryHash", ro: true },
  { name: "recordCreatedAt", ro: true },
  { name: "recordUpdatedAt", ro: true },
];

const CLASSES: Record<ClassName, ClassDef> = {
  AcornOutcome: {
    create: true,
    delete: true,
    props: [
      { name: "content", alias: { TextContent: "text" } },
      { name: "description" },
      { name: "githubLink" },
      { name: "scopeType" },
      { name: "achievementStatus" },
      { name: "targetDate" },
      { name: "taskList" },
      { name: "smallsEstimate" },
      { name: "timeFrame" },
      { name: "inBreakdown" },
      { name: "tags", kind: "ref", collection: true },
      { name: "creator", kind: "ref", ro: true },
      { name: "editor", kind: "ref", ro: true },
      { name: "timestampCreated", ro: true },
      { name: "timestampUpdated", ro: true },
      { name: "isImported", ro: true },
      { name: "parent", kind: "ref", ro: true },
      {
        name: "children",
        kind: "ref",
        collection: true,
        ro: true,
        alias: { Container: "children" },
      },
      ...WIRE_PROPS,
    ],
  },
  AcornConnection: {
    create: true,
    delete: true,
    props: [
      { name: "parent", kind: "ref" },
      { name: "child", kind: "ref" },
      { name: "siblingOrder" },
      { name: "randomizer" },
      { name: "isImported", ro: true },
      ...WIRE_PROPS,
    ],
  },
  AcornEntryPoint: {
    create: true,
    delete: true,
    props: [
      { name: "color" },
      { name: "outcome", kind: "ref" },
      { name: "creator", kind: "ref", ro: true },
      { name: "createdAtTime", ro: true },
      { name: "isImported", ro: true },
      ...WIRE_PROPS,
    ],
  },
  AcornOutcomeComment: {
    create: true,
    delete: true,
    props: [
      { name: "outcome", kind: "ref" },
      { name: "content", alias: { TextContent: "text" } },
      { name: "creator", kind: "ref", ro: true },
      { name: "unixTimestamp", ro: true },
      { name: "isImported", ro: true },
      ...WIRE_PROPS,
    ],
  },
  AcornOutcomeMember: {
    create: true,
    delete: true,
    props: [
      { name: "outcome", kind: "ref" },
      { name: "member", kind: "ref" },
      { name: "creator", kind: "ref", ro: true },
      { name: "unixTimestamp", ro: true },
      { name: "isImported", ro: true },
      ...WIRE_PROPS,
    ],
  },
  AcornTag: {
    create: true,
    delete: true,
    props: [
      { name: "text" },
      { name: "backgroundColor" },
      ...WIRE_PROPS,
    ],
  },
  AcornProjectMeta: {
    create: true,
    delete: false,
    props: [
      { name: "name" },
      { name: "image" },
      { name: "layeringAlgorithm" },
      { name: "topPriorityOutcomes", kind: "ref", collection: true },
      { name: "creator", kind: "ref", ro: true },
      { name: "createdAtTime", ro: true },
      { name: "isImported", ro: true },
      { name: "isMigrated", ro: true },
      ...WIRE_PROPS,
      // never `passphrase` — the project's membership secret (design §4.1)
    ],
  },
  AcornMember: {
    create: false,
    delete: false,
    props: [{ name: "agent", kind: "ref", ro: true }, ...WIRE_PROPS],
  },
  AcornProfile: {
    create: true,
    delete: false,
    props: [
      { name: "firstName" },
      { name: "lastName" },
      { name: "handle" },
      { name: "status" },
      { name: "avatarUrl" },
      { name: "agent", kind: "ref", ro: true },
      { name: "agentPubKey", ro: true },
      { name: "isImported", ro: true },
      ...WIRE_PROPS,
    ],
  },
};

function classIri(name: ClassName): string {
  return `acorn://${name.slice("Acorn".length)}`;
}

function propShape(p: Prop): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    path: `acorn://${p.name}`,
    name: p.name,
  };
  if (p.kind === "ref") {
    shape.node_kind = "IRI";
    shape.relation_kind = p.collection ? "hasMany" : "hasOne";
  }
  if (p.collection) shape.collection = true;
  else shape.max_count = 1;
  if (p.alias) shape.alias = p.alias;
  if (!p.ro) {
    shape.writable = true;
    shape.setter = UPDATE_SETTER;
  }
  return shape;
}

/** `mountShapes()` for a given language address (the constructors' call
 *  source is `<lang>://class/<ClassName>`). Pure — injectable for tests. */
export function mountShapesFor(lang: string) {
  return {
    version: SHAPES_VERSION,
    shapes: CLASS_NAMES.map((name) => {
      const def = CLASSES[name];
      const shape: Record<string, unknown> = {
        target_class: classIri(name),
        constructor_actions: def.create
          ? [
              {
                action: "call",
                source: `${lang}://class/${name}`,
                predicate: "create",
                target: "{}",
              },
            ]
          : [],
        destructor_actions: def.delete
          ? [{ action: "call", source: "this", predicate: "delete", target: "{}" }]
          : [],
        properties: [
          {
            path: "rdf://type",
            name: "type",
            has_value: classIri(name),
            min_count: 1,
            max_count: 1,
          },
          ...def.props.map(propShape),
        ],
      };
      return { name, shape };
    }),
  };
}
