import { TypeKind, Type, ClassType, EnumType, UnionType, ClassProperty } from "../Type";
import { matchType, nullableFromUnion, removeNullFromUnion } from "../TypeUtils";
import { Name, DependencyName, Namer, funPrefixNamer } from "../Naming";
import {
    legalizeCharacters,
    isLetterOrUnderscore,
    isLetterOrUnderscoreOrDigit,
    stringEscape,
    splitIntoWords,
    combineWords,
    firstUpperWordStyle,
    allUpperWordStyle,
    allLowerWordStyle,
    camelCase
} from "../support/Strings";
import { assert, defined } from "../support/Support";
import { StringOption, BooleanOption, Option, OptionValues, getOptionValues } from "../RendererOptions";
import { Sourcelike, maybeAnnotated, modifySource } from "../Source";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import { TargetLanguage } from "../TargetLanguage";
import { ConvenienceRenderer } from "../ConvenienceRenderer";
import { RenderContext } from "../Renderer";
import { lowerCase, snakeCase } from "lodash";

export const zigOptions = {
    justTypes: new BooleanOption("just-types", "Plain types only", false),
    justTypesAndPackage: new BooleanOption("just-types-and-package", "Plain types with package only", false),
    packageName: new StringOption("package", "Generated package name", "NAME", "main"),
    multiFileOutput: new BooleanOption("multi-file-output", "Renders each top-level object in its own Zig file", false)
};

export class ZigTargetLanguage extends TargetLanguage {
    constructor() {
        super("Zig", ["zig", "ziglang"], "zig");
    }

    protected getOptions(): Option<any>[] {
        return [zigOptions.justTypes, zigOptions.packageName, zigOptions.multiFileOutput, zigOptions.justTypesAndPackage];
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
        isLetterOrUnderscore
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
        return camelNamingFunction;
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected get enumCasesInGlobalNamespace(): boolean {
        return true;
    }

    protected makeTopLevelDependencyNames(_: Type, topLevelName: Name): DependencyName[] {
        const unmarshalName = new DependencyName(
            snakeNamingFunction,
            topLevelName.order,
            lookup => `unmarshal_${lookup(topLevelName)}`
        );
        return [unmarshalName];
    }

    /// startFile takes a file name, lowercases it, appends ".zig" to it, and sets it as the current filename.
    protected startFile(basename: Sourcelike): void {
        if (this._options.multiFileOutput === false) {
            return;
        }

        assert(this._currentFilename === undefined, "Previous file wasn't finished: " + this._currentFilename);
        // FIXME: The filenames should actually be Sourcelikes, too
        this._currentFilename = `${this.sourcelikeToString(basename)}.zig`.toLowerCase();
        this.initializeEmitContextForFilename(this._currentFilename);
    }

    /// endFile pushes the current file name onto the collection of finished files and then resets the current file name. These finished files are used in index.ts to write the output.
    protected endFile(): void {
        if (this._options.multiFileOutput === false) {
            return;
        }

        this.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    private emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("};");
    }

    private emitFunc(decl: Sourcelike, f: () => void): void {
        this.emitBlock(["fn ", decl], f);
    }

    private emitStruct(c: ClassType, name: Name): void {
        const structBody = () => this.forEachClassProperty(c, "none", (name, jsonName, prop) => {
            this.emitDescription(this.descriptionForClassProperty(c, jsonName));
            this.emitLine(name, ": ", this.propertyZigType(prop), ",");
        });
        this.emitBlock(["const ", name, " = struct"], structBody);
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
            _anyType => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "?[]u8"),
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
                // This doesn't actually work.
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
        this.startFile(name);

        if (
            this._options.multiFileOutput &&
            this._options.justTypes === false &&
            this._options.justTypesAndPackage === false &&
            this.leadingComments === undefined
        ) {
            this.emitLineOnce(
                "// This file was generated from JSON Schema using quicktype, do not modify it directly."
            );
            this.emitLineOnce("// To parse and unparse this JSON data, add this code to your project and do:");
            this.emitLineOnce("//");
        }

        if (this.namedTypeToNameForTopLevel(t) === undefined) {
            this.emitLine("type ", name, " ", this.zigType(t));
        }
    }

    private emitClass(c: ClassType, className: Name): void {
        this.startFile(className);
        this.emitDescription(this.descriptionForType(c));
        this.emitStruct(c, className);
        this.endFile();
    }

    private emitEnum(e: EnumType, enumName: Name): void {
        this.startFile(enumName);
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("type ", enumName, " string");
        this.emitLine("const (");
        this.indent(() =>
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                this.emitLine(name, " ", enumName, ' = "', stringEscape(jsonName), '"');
            })
        );
        this.emitLine(")");
        this.endFile();
    }

    private emitUnion(u: UnionType, unionName: Name): void {
        this.emitDescription(this.descriptionForType(u));

        const [, nonNulls] = removeNullFromUnion(u);

        this.emitBlock(["const ", unionName, " = union(enum)"], () => {
            this.forEachUnionMember(u, nonNulls, "none", null, (fieldName, t) => {
                this.emitLine([fieldName, ": ", this.zigType(t), ","]);
            });
        });
    }

    private emitSingleFileHeaderComments(): void {
        this.forEachTopLevel("none", (_: Type, name: Name) => {
            this.emitLine("//");
        });
    }

    private emitHelperFunctions(): void {
        if (this.haveNamedUnions) {
            this.startFile("JSONSchemaSupport");
            if (this._options.multiFileOutput) {
                this.emitLineOnce('const std = @import("std");');
            }
            this.ensureBlankLine();
            this.endFile();
        }
    }

    protected emitSourceStructure(): void {
        if (
            this._options.multiFileOutput === false &&
            this._options.justTypes === false &&
            this._options.justTypesAndPackage === false &&
            this.leadingComments === undefined
        ) {
            this.emitSingleFileHeaderComments();
        }

        this.forEachTopLevel(
            "leading-and-interposing",
            (t, name) => this.emitTopLevel(t, name),
            t =>
                !(this._options.justTypes || this._options.justTypesAndPackage) ||
                this.namedTypeToNameForTopLevel(t) === undefined
        );
        this.forEachObject("leading-and-interposing", (c: ClassType, className: Name) => this.emitClass(c, className));
        this.forEachEnum("leading-and-interposing", (u: EnumType, enumName: Name) => this.emitEnum(u, enumName));
        this.forEachUnion("leading-and-interposing", (u: UnionType, unionName: Name) => this.emitUnion(u, unionName));

        if (this._options.justTypes || this._options.justTypesAndPackage) {
            return;
        }

        this.emitHelperFunctions();
    }
}
