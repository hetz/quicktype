"use strict";

import { OrderedSet, OrderedMap, Map, Set, Collection, List } from "immutable";
import stringHash = require("string-hash");
import { TypeKind, PrimitiveTypeKind, NamedTypeKind } from "Reykjavik";
import { defined, panic, assert } from "./Support";

// FIXME: OrderedMap?  We lose the order in PureScript right now, though,
// and maybe even earlier in the TypeScript driver.
export type TopLevels = Map<string, Type>;

export abstract class Type {
    constructor(readonly kind: TypeKind) {}

    isNamedType(): this is NamedType {
        return false;
    }

    abstract get children(): OrderedSet<Type>;

    directlyReachableTypes<T>(setForType: (t: Type) => OrderedSet<T> | null): OrderedSet<T> {
        const set = setForType(this);
        if (set) return set;
        return orderedSetUnion(this.children.map((t: Type) => t.directlyReachableTypes(setForType)));
    }

    abstract get isNullable(): boolean;
    abstract map(f: (t: Type) => Type): Type;

    equals(other: any): boolean {
        return typesEqual(this, other);
    }

    abstract expandForEquality(other: Type): [Type, Type][] | boolean;
    abstract flatHashCode(): number;
    hashCode(): number {
        return this.flatHashCode();
    }
}

export class PrimitiveType extends Type {
    readonly kind: PrimitiveTypeKind;

    constructor(kind: PrimitiveTypeKind) {
        super(kind);
    }

    get children(): OrderedSet<Type> {
        return OrderedSet();
    }

    get isNullable(): boolean {
        return this.kind === "null";
    }

    map(f: (t: Type) => Type): this {
        return this;
    }

    expandForEquality(other: any): boolean {
        if (!(other instanceof PrimitiveType)) return false;
        return this.kind === other.kind;
    }

    flatHashCode(): number {
        return stringHash(this.kind) | 0;
    }
}

function isNull(t: Type): t is PrimitiveType {
    return t.kind === "null";
}

export class ArrayType extends Type {
    readonly kind: "array";

    constructor(readonly items: Type) {
        super("array");
    }

    get children(): OrderedSet<Type> {
        return OrderedSet([this.items]);
    }

    get isNullable(): boolean {
        return false;
    }

    map(f: (t: Type) => Type): ArrayType {
        const items = f(this.items);
        if (items === this.items) return this;
        return new ArrayType(items);
    }

    expandForEquality(other: Type): [Type, Type][] | boolean {
        if (!(other instanceof ArrayType)) return false;
        return [[this.items, other.items]];
    }

    flatHashCode(): number {
        return (stringHash(this.kind) + this.items.hashCode()) | 0;
    }
}

export class MapType extends Type {
    readonly kind: "map";

    constructor(readonly values: Type) {
        super("map");
    }

    get children(): OrderedSet<Type> {
        return OrderedSet([this.values]);
    }

    get isNullable(): boolean {
        return false;
    }

    map(f: (t: Type) => Type): MapType {
        const values = f(this.values);
        if (values === this.values) return this;
        return new MapType(values);
    }

    expandForEquality(other: Type): [Type, Type][] | boolean {
        if (!(other instanceof MapType)) return false;
        return [[this.values, other.values]];
    }

    flatHashCode(): number {
        return (stringHash(this.kind) + this.values.hashCode()) | 0;
    }
}

// FIXME: In the case of overlapping prefixes and suffixes we will
// produce a name that includes the overlap twice.  For example, for
// the names "aaa" and "aaaa" we have the common prefix "aaa" and the
// common suffix "aaa", so we will produce the combined name "aaaaaa".
function combineNames(names: Collection<any, string>): string {
    const first = names.first();
    if (first === undefined) {
        return panic("Named type has no names");
    }
    if (names.count() === 1) {
        return first;
    }
    let prefixLength = first.length;
    let suffixLength = first.length;
    names.rest().forEach(n => {
        prefixLength = Math.min(prefixLength, n.length);
        for (let i = 0; i < prefixLength; i++) {
            if (first[i] !== n[i]) {
                prefixLength = i;
                break;
            }
        }

        suffixLength = Math.min(suffixLength, n.length);
        for (let i = 0; i < suffixLength; i++) {
            if (first[first.length - i - 1] !== n[n.length - i - 1]) {
                suffixLength = i;
                break;
            }
        }
    });
    const prefix = prefixLength > 2 ? first.substr(0, prefixLength) : "";
    const suffix = suffixLength > 2 ? first.substr(first.length - suffixLength) : "";
    const combined = prefix + suffix;
    if (combined.length > 2) {
        return combined;
    }
    return first;
}

export type NameOrNames = string | OrderedSet<string>;

export abstract class NamedType extends Type {
    private _names: OrderedSet<string>;
    private _areNamesInferred: boolean;

    constructor(kind: NamedTypeKind, nameOrNames: NameOrNames, areNamesInferred: boolean) {
        super(kind);
        if (typeof nameOrNames === "string") {
            this._names = OrderedSet([nameOrNames]);
        } else {
            this._names = nameOrNames;
        }
        this._areNamesInferred = areNamesInferred;
    }

    isNamedType(): this is NamedType {
        return true;
    }

    get names(): OrderedSet<string> {
        return this._names;
    }

    get areNamesInferred(): boolean {
        return this._areNamesInferred;
    }

    addName(name: string, isInferred: boolean): void {
        if (isInferred && !this._areNamesInferred) {
            return;
        }
        if (this._areNamesInferred && !isInferred) {
            this._names = OrderedSet([name]);
            this._areNamesInferred = isInferred;
        } else {
            this._names = this._names.add(name);
        }
    }

    setGivenName(name: string): void {
        this._names = OrderedSet([name]);
        this._areNamesInferred = false;
    }

    get combinedName(): string {
        return combineNames(this._names);
    }
}

export class ClassType extends NamedType {
    kind: "class";

    constructor(names: NameOrNames, areNamesInferred: boolean, private _properties?: Map<string, Type>) {
        super("class", names, areNamesInferred);
    }

    setProperties(properties: Map<string, Type>): void {
        if (this._properties !== undefined) {
            return panic("Can only set class properties once");
        }
        this._properties = properties;
    }

    get properties(): Map<string, Type> {
        if (this._properties === undefined) {
            return panic("Class properties accessed before they were set");
        }
        return this._properties;
    }

    get sortedProperties(): OrderedMap<string, Type> {
        const sortedKeys = this.properties.keySeq().sort();
        const props = sortedKeys.map((k: string): [string, Type] => [k, defined(this.properties.get(k))]);
        return OrderedMap(props);
    }

    get children(): OrderedSet<Type> {
        return this.sortedProperties.toOrderedSet();
    }

    get isNullable(): boolean {
        return false;
    }

    map(f: (t: Type) => Type): ClassType {
        let same = true;
        const properties = this.properties.map(t => {
            const ft = f(t);
            if (ft !== t) same = false;
            return ft;
        });
        if (same) return this;
        return new ClassType(this.names, this.areNamesInferred, properties);
    }

    expandForEquality(other: Type): [Type, Type][] | boolean {
        if (!(other instanceof ClassType)) return false;
        if (!this.names.equals(other.names)) return false;
        if (this.properties.size !== other.properties.size) return false;
        if (this.properties.size === 0) return true;
        const queue: [Type, Type][] = [];
        this.properties.forEach((t, name) => {
            const otherT = other.properties.get(name);
            if (!otherT) return false;
            queue.push([t, otherT]);
        });
        if (queue.length !== this.properties.size) return false;
        return queue;
    }

    flatHashCode(): number {
        return (stringHash(this.kind) + this.names.hashCode() + this.properties.size) | 0;
    }

    hashCode(): number {
        let hash = this.flatHashCode();
        this.properties.forEach((t, n) => {
            hash = (hash + t.flatHashCode() + stringHash(n)) | 0;
        });
        return hash;
    }
}

export class EnumType extends NamedType {
    kind: "enum";

    constructor(names: NameOrNames, areNamesInferred: boolean, readonly cases: OrderedSet<string>) {
        super("enum", names, areNamesInferred);
    }

    get children(): OrderedSet<Type> {
        return OrderedSet();
    }

    get isNullable(): boolean {
        return false;
    }

    map(f: (t: Type) => Type): this {
        return this;
    }

    expandForEquality(other: any): boolean {
        if (!(other instanceof EnumType)) return false;
        return this.names.equals(other.names) && this.cases.equals(other.cases);
    }

    flatHashCode(): number {
        return (stringHash(this.kind) + this.names.hashCode() + this.cases.hashCode()) | 0;
    }
}

export class UnionType extends NamedType {
    kind: "union";

    constructor(names: NameOrNames, areNamesInferred: boolean, readonly members: OrderedSet<Type>) {
        super("union", names, areNamesInferred);
        assert(members.size > 1);
    }

    findMember = (kind: TypeKind): Type | undefined => {
        return this.members.find((t: Type) => t.kind === kind);
    };

    get children(): OrderedSet<Type> {
        return this.sortedMembers;
    }

    get isNullable(): boolean {
        return this.findMember("null") !== undefined;
    }

    map(f: (t: Type) => Type): UnionType {
        let same = true;
        const members = this.members.map(t => {
            const ft = f(t);
            if (ft !== t) same = false;
            return ft;
        });
        if (same) return this;
        return new UnionType(this.names, this.areNamesInferred, members);
    }

    get sortedMembers(): OrderedSet<Type> {
        // FIXME: We're assuming no two members of the same kind.
        return this.members.sortBy(t => t.kind);
    }

    equals(other: any): boolean {
        if (!(other instanceof UnionType)) return false;
        return this.names.equals(other.names) && this.members.equals(other.members);
    }

    expandForEquality(other: Type): [Type, Type][] | boolean {
        if (!(other instanceof UnionType)) return false;
        if (!this.names.equals(other.names)) return false;
        if (this.members.size !== other.members.size) return false;
        if (this.members.size === 0) return true;
        const otherByKind: { [kind: string]: Type } = {};
        other.members.forEach(t => {
            otherByKind[t.kind] = t;
        });
        const queue: [Type, Type][] = [];
        this.members.forEach(t => {
            const otherT = otherByKind[t.kind];
            if (!otherT) return false;
            queue.push([t, otherT]);
        });
        if (queue.length !== this.members.size) return false;
        return queue;
    }

    flatHashCode(): number {
        return (stringHash(this.kind) + this.names.hashCode() + this.members.size) | 0;
    }

    hashCode(): number {
        let hash = this.flatHashCode();
        this.members.forEach(t => {
            hash = (hash + t.flatHashCode()) | 0;
        });
        return hash;
    }
}

function typesEqual(t1: Type, t2: any): boolean {
    if (t1 === t2) return true;
    let queueOrResult = t1.expandForEquality(t2);
    if (typeof queueOrResult === "boolean") return queueOrResult;
    let queue = queueOrResult;
    const alreadySeenByHash: { [hash: string]: [Type, Type][] } = {};
    function alreadySeen(types: [Type, Type]): boolean {
        const hash = types[0].hashCode().toString();
        let pairs = alreadySeenByHash[hash];
        if (pairs) {
            for (const [o1, o2] of pairs) {
                if (o1 === types[0] && o2 === types[1]) return true;
            }
        } else {
            alreadySeenByHash[hash] = pairs = [];
        }
        pairs.push(types);
        return false;
    }
    for (;;) {
        const maybePair = queue.pop();
        if (!maybePair) return true;
        [t1, t2] = maybePair;
        if (t1 === t2) continue;
        if (alreadySeen(maybePair)) continue;
        queueOrResult = t1.expandForEquality(t2);
        if (typeof queueOrResult === "boolean") {
            if (!queueOrResult) return false;
            continue;
        }
        for (const p of queueOrResult) {
            queue.push(p);
        }
    }
}

export function removeNullFromUnion(t: UnionType): [PrimitiveType | null, OrderedSet<Type>] {
    const nullType = t.findMember("null");
    if (!nullType) {
        return [null, t.members];
    }
    return [nullType as PrimitiveType, t.members.filterNot(isNull).toOrderedSet()];
}

export function nullableFromUnion(t: UnionType): Type | null {
    const [hasNull, nonNulls] = removeNullFromUnion(t);
    if (!hasNull) return null;
    if (nonNulls.size !== 1) return null;
    return defined(nonNulls.first());
}

export function makeNullable(t: Type, typeNames: NameOrNames, areNamesInferred: boolean): Type {
    if (t.kind === "null") {
        return t;
    }
    if (!(t instanceof UnionType)) {
        return new UnionType(typeNames, areNamesInferred, OrderedSet([t, new PrimitiveType("null")]));
    }
    const [maybeNull, nonNulls] = removeNullFromUnion(t);
    if (maybeNull) return t;
    return new UnionType(typeNames, areNamesInferred, nonNulls.add(new PrimitiveType("null")));
}

export function removeNull(t: Type): Type {
    if (!(t instanceof UnionType)) {
        return t;
    }
    const [_, nonNulls] = removeNullFromUnion(t);
    const first = nonNulls.first();
    if (first) {
        if (nonNulls.size === 1) return first;
        return new UnionType(t.names, t.areNamesInferred, nonNulls);
    }
    return panic("Trying to remove null results in empty union.");
}

// FIXME: The outer OrderedSet should be some Collection, but I can't figure out
// which one.  Collection.Indexed doesn't work with OrderedSet, which is unfortunate.
function orderedSetUnion<T>(sets: OrderedSet<OrderedSet<T>>): OrderedSet<T> {
    const setArray = sets.toArray();
    if (setArray.length === 0) return OrderedSet();
    if (setArray.length === 1) return setArray[0];
    return setArray[0].union(...setArray.slice(1));
}

export function filterTypes<T extends Type>(
    predicate: (t: Type) => t is T,
    graph: TopLevels,
    childrenOfType?: (t: Type) => Collection<any, Type>
): OrderedSet<T> {
    let seen = Set<Type>();
    let types = List<T>();

    function addFromType(t: Type): void {
        if (seen.has(t)) return;
        seen = seen.add(t);

        const children = childrenOfType ? childrenOfType(t) : t.children;
        children.forEach(addFromType);
        if (predicate(t)) {
            types = types.push(t);
        }
    }

    graph.forEach(addFromType);
    return types.reverse().toOrderedSet();
}

export function allNamedTypes(
    graph: TopLevels,
    childrenOfType?: (t: Type) => Collection<any, Type>
): OrderedSet<NamedType> {
    return filterTypes<NamedType>((t: Type): t is NamedType => t.isNamedType(), graph, childrenOfType);
}

export type SeparatedNamedTypes = {
    classes: OrderedSet<ClassType>;
    enums: OrderedSet<EnumType>;
    unions: OrderedSet<UnionType>;
};

export function separateNamedTypes(types: Collection<any, NamedType>): SeparatedNamedTypes {
    const classes = types.filter((t: NamedType) => t instanceof ClassType).toOrderedSet() as OrderedSet<ClassType>;
    const enums = types.filter((t: NamedType) => t instanceof EnumType).toOrderedSet() as OrderedSet<EnumType>;
    const unions = types.filter((t: NamedType) => t instanceof UnionType).toOrderedSet() as OrderedSet<UnionType>;

    return { classes, enums, unions };
}

export function allNamedTypesSeparated(
    graph: TopLevels,
    childrenOfType?: (t: Type) => Collection<any, Type>
): SeparatedNamedTypes {
    const types = allNamedTypes(graph, childrenOfType);
    return separateNamedTypes(types);
}

export function matchType<U>(
    t: Type,
    anyType: (anyType: PrimitiveType) => U,
    nullType: (nullType: PrimitiveType) => U,
    boolType: (boolType: PrimitiveType) => U,
    integerType: (integerType: PrimitiveType) => U,
    doubleType: (doubleType: PrimitiveType) => U,
    stringType: (stringType: PrimitiveType) => U,
    arrayType: (arrayType: ArrayType) => U,
    classType: (classType: ClassType) => U,
    mapType: (mapType: MapType) => U,
    enumType: (enumType: EnumType) => U,
    unionType: (unionType: UnionType) => U
): U {
    if (t instanceof PrimitiveType) {
        const f = {
            any: anyType,
            null: nullType,
            bool: boolType,
            integer: integerType,
            double: doubleType,
            string: stringType
        }[t.kind];
        if (f) return f(t);
        return panic(`Unknown PrimitiveType: ${t.kind}`);
    } else if (t instanceof ArrayType) return arrayType(t);
    else if (t instanceof ClassType) return classType(t);
    else if (t instanceof MapType) return mapType(t);
    else if (t instanceof EnumType) return enumType(t);
    else if (t instanceof UnionType) return unionType(t);
    return panic("Unknown Type");
}
