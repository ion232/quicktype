
import { mapFirst } from "collection-utils";
import { TypeKind, Type, ClassType, EnumType, UnionType, ClassProperty } from "../Type";
import { matchType, nullableFromUnion, removeNullFromUnion } from "../TypeUtils";
import { Name, DependencyName, Namer, funPrefixNamer } from "../Naming";
import {
    legalizeCharacters,
    isLetterOrUnderscore,
    isLetterOrUnderscoreOrDigit,
    stringEscape,
    splitIntoWords,
    isAscii,
    combineWords,
    firstUpperWordStyle,
    allLowerWordStyle,
} from "../support/Strings";
import { assert, defined } from "../support/Support";
import { BooleanOption, Option, OptionValues, getOptionValues } from "../RendererOptions";
import { Sourcelike, maybeAnnotated } from "../Source";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import { TargetLanguage } from "../TargetLanguage";
import { ConvenienceRenderer, ForbiddenWordsInfo } from "../ConvenienceRenderer";
import { RenderContext } from "../Renderer";

export const zigOptions = {
    public: new BooleanOption("public", "Make types and fields public", true)
};

export class ZigTargetLanguage extends TargetLanguage {
    constructor() {
        super("Zig", ["zig", "ziglang"], "zig");
    }

    protected getOptions(): Option<any>[] {
        return [zigOptions.public];
    }

    get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    protected makeRenderer(renderContext: RenderContext, untypedOptionValues: { [name: string]: any }): ZigRenderer {
        return new ZigRenderer(this, renderContext, getOptionValues(zigOptions, untypedOptionValues));
    }

    protected get defaultIndentation(): string {
        return "    ";
    }
}

// Keywords taken from: https://github.com/ziglang/zig-spec/blob/master/grammar/grammar.y
const keywords = [
    "addrspace",
    "align",
    "allowzero",
    "and",
    "anyframe",
    "anytype",
    "asm",
    "async",
    "await",
    "break",
    "callconv",
    "catch",
    "comptime",
    "const",
    "continue",
    "defer",
    "else",
    "enum",
    "errdefer",
    "error",
    "export",
    "extern",
    "fn",
    "for",
    "if",
    "inline",
    "noalias",
    "nosuspend",
    "noinline",
    "opaque",
    "or",
    "orelse",
    "packed",
    "pub",
    "resume",
    "return",
    "linksection",
    "struct",
    "suspend",
    "switch",
    "test",
    "threadlocal",
    "try",
    "union",
    "unreachable",
    "usingnamespace",
    "var",
    "volatile",
    "while"
];

const snakeNamingFunction = funPrefixNamer("default", (original: string) => zigNameStyle(original, true));
const camelNamingFunction = funPrefixNamer("camel", (original: string) => zigNameStyle(original, false));

const isAsciiLetterOrUnderscore = (codePoint: number): boolean => {
    if (!isAscii(codePoint)) {
        return false;
    }

    return isLetterOrUnderscore(codePoint);
};

const legalizeName = legalizeCharacters(isLetterOrUnderscoreOrDigit);

function zigNameStyle(original: string, isSnakeCase: boolean): string {
    const words = splitIntoWords(original);

    const wordStyle = isSnakeCase ? allLowerWordStyle : firstUpperWordStyle;

    const combined = combineWords(
        words,
        legalizeName,
        wordStyle,
        wordStyle,
        wordStyle,
        wordStyle,
        isSnakeCase ? "_" : "",
        isAsciiLetterOrUnderscore
    );

    return combined === "_" ? "_underscore" : combined;
}

const primitiveValueTypeKinds: TypeKind[] = ["integer", "double", "bool", "string"];
const compoundTypeKinds: TypeKind[] = ["array", "class", "map", "enum"];

function isValueType(t: Type): boolean {
    const kind = t.kind;
    return primitiveValueTypeKinds.indexOf(kind) >= 0 || kind === "class" || kind === "enum";
}

function canOmitEmpty(cp: ClassProperty): boolean {
    if (!cp.isOptional) return false;
    const t = cp.type;
    return ["union", "null", "any"].indexOf(t.kind) < 0;
}

export class ZigRenderer extends ConvenienceRenderer {
    private _currentFilename: string | undefined;

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof zigOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer {
        return camelNamingFunction;
    }

    protected namerForObjectProperty(): Namer {
        return snakeNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer {
        return snakeNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer {
        return snakeNamingFunction;
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected forbiddenForObjectProperties(_c: ClassType, _className: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForUnionMembers(_u: UnionType, _unionName: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForEnumCases(_e: EnumType, _enumName: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    /// startFile takes a file name, lowercases it, appends ".zig" to it, and sets it as the current filename.
    protected startFile(basename: Sourcelike): void {

        assert(this._currentFilename === undefined, "Previous file wasn't finished: " + this._currentFilename);
        // FIXME: The filenames should actually be Sourcelikes, too
        this._currentFilename = `${this.sourcelikeToString(basename)}.zig`.toLowerCase();
        this.initializeEmitContextForFilename(this._currentFilename);
    }

    /// endFile pushes the current file name onto the collection of finished files and then resets the current file name. These finished files are used in index.ts to write the output.
    protected endFile(): void {
        this.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    private visibility(): string {
        return this._options.public ? "pub" : "";
    }

    private emitBlock(preamble: Sourcelike, last: string, f: () => void): void {
        this.emitLine(preamble, "{");
        this.indent(f);
        this.emitLine(`}${last}`);
    }

    private emitGettyBlock(renameFields: Map<Name, string>, isSerialize: boolean) {
        const fieldAttributesLine = (jsonName: string) => {
            return `.rename = "${jsonName}",`;
        };
        const attributesBlock = () => {
            renameFields.forEach((jsonName, name, _) => {
                this.emitLine([".", name, " = .{ ", fieldAttributesLine(jsonName), " },"])
            });
        };
        const attributes = () => {
            this.emitBlock([this.visibility(), " const attributes = ."], ";", attributesBlock);
        };

        const extension = isSerialize ? "sb" : "db";
        this.emitBlock([this.visibility(), ` const @"getty.${extension}" = struct `], ";", attributes);
    }

    private emitSerdeBlocks(renameFields: Map<Name, string>) {
        if (renameFields.size > 0) {
            this.emitLine();
            this.emitGettyBlock(renameFields, false);
            this.emitLine();
            this.emitGettyBlock(renameFields, true);
        }
    }

    private nullableZigType(t: Type, withIssues: boolean): Sourcelike {
        const zigType = this.zigType(t, withIssues);
        return ["?", zigType];
    }

    private propertyZigType(prop: ClassProperty): Sourcelike {
        const t = prop.type;
        if (prop.isOptional) {
            return this.nullableZigType(t, true);
        }
        return this.zigType(t, true);
    }

    private zigType(t: Type, withIssues = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            _anyType => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "std.json.Value"),
            _nullType => maybeAnnotated(withIssues, nullTypeIssueAnnotation, "?[]u8"),
            _boolType => "bool",
            _integerType => "i64",
            _doubleType => "f64",
            _stringType => "[]u8",
            arrayType => ["[]", this.zigType(arrayType.items, withIssues)],
            classType => this.nameForNamedType(classType),
            mapType => {
                let valueSource: Sourcelike;
                const v = mapType.values;
                if (v instanceof UnionType && nullableFromUnion(v) === null) {
                    valueSource = ["?", this.nameForNamedType(v)];
                } else {
                    valueSource = this.zigType(v, withIssues);
                }
                return ["std.StringHashMap(", valueSource, ")"];
            },
            enumType => this.nameForNamedType(enumType),
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable !== null) return this.nullableZigType(nullable, withIssues);
                return this.nameForNamedType(unionType);
            }
        );
    }

    private emitTopLevel(t: Type, name: Name): void {
    }

    private emitStruct(c: ClassType, name: Name): void {
        const structBody = () => {
            var renameFields = new Map<Name, string>();
            this.forEachClassProperty(c, "none", (name, jsonName, prop) => {
                this.emitDescription(this.descriptionForClassProperty(c, jsonName));
                this.emitLine(name, ": ", this.propertyZigType(prop), ",")
                if (this.sourcelikeToString(name) !== jsonName) {
                    renameFields.set(name, jsonName);
                }
            });
            this.emitSerdeBlocks(renameFields);
        };
        this.emitBlock([this.visibility(), " const ", name, " = struct "], ";", structBody);
    }

    private emitClass(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitStruct(c, className);
    }

    private emitEnum(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));

        const enumBody = () => {
            var renameFields = new Map<Name, string>();
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                this.emitLine([name, ","]);
                if (this.sourcelikeToString(name) !== jsonName) {
                    renameFields.set(name, jsonName);
                }
            });
            this.emitSerdeBlocks(renameFields);
        };
        this.emitBlock([this.visibility(), " const ", enumName, " = enum "], ";", enumBody);
    }

    private emitUnion(u: UnionType, unionName: Name): void {
        this.emitDescription(this.descriptionForType(u));

        const [, nonNulls] = removeNullFromUnion(u);

        this.emitBlock([this.visibility(), " const ", unionName, " = union(enum)"], ";", () => {
            this.forEachUnionMember(u, nonNulls, "none", null, (fieldName, t) => {
                this.emitLine([fieldName, ": ", this.zigType(t), ","]);
            });
        });
    }

    private emitLeadingComments(): void {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
            return;
        }

        const topLevelName = defined(mapFirst(this.topLevels)).getCombinedName();
        this.emitMultiline(
            `// Example code showing how to deserialize a model using "getty-zig/json".
//
// const std = @import("std");
// const json = @import("json");
//
// pub fn main() anyerror!void {
//    const json_string = "...";
//    const model = try json.fromSlice(null, ${topLevelName}, json_string);
//    std.debug.print("\{any\}\\n", .\{model\});
// }`
        );
    }

    protected emitSourceStructure(): void {
        this.emitLeadingComments();
        this.emitLine();
        this.emitLine(`const std = @import("std");`);

        this.forEachTopLevel(
            "leading",
            (t, name) => this.emitTopLevel(t, name),
            t => this.namedTypeToNameForTopLevel(t) === undefined
        );

        this.forEachObject("leading-and-interposing", (c: ClassType, className: Name) => this.emitClass(c, className));
        this.forEachUnion("leading-and-interposing", (u: UnionType, unionName: Name) => this.emitUnion(u, unionName));
        this.forEachEnum("leading-and-interposing", (e: EnumType, enumName: Name) => this.emitEnum(e, enumName));
    }
}
