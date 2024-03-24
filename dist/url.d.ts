declare function Url(): void;
declare function urlParse(url: any, parseQueryString?: boolean, slashesDenoteHost?: boolean): any;
declare function urlFormat(urlObject: any): any;
declare function urlResolve(source: string, relative: any): any;
declare function urlResolveObject(source: string, relative: any): any;
declare class URLSearchParams {
    params: any;
    constructor(queryString: string);
    static parse(queryString: string): Map<any, any>;
    has(key: string): any;
    get(key: string): any;
    set(key: string, value: string): void;
    append(key: string, value: string): void;
    delete(key: string): void;
    toString(): string;
}
declare class URL {
    _protocol: any;
    _slashes: any;
    _auth: any;
    _hostname: any;
    _port: any;
    _host: any;
    _pathname: any;
    _search: any;
    _query: any;
    _hash: any;
    _path: any;
    _href: any;
    _searchParams: any;
    constructor(urlString: string | URL, base?: string);
    toString(): any;
    get base(): any;
    get protocol(): any;
    get slashes(): any;
    get auth(): any;
    get hostname(): any;
    get port(): any;
    get host(): any;
    get pathname(): any;
    get search(): any;
    get query(): any;
    get hash(): any;
    get path(): any;
    get href(): any;
    get searchParams(): any;
}
declare const _default: {
    URLSearchParams: typeof URLSearchParams;
    URL: typeof URL;
    Url: typeof Url;
    parse: typeof urlParse;
    resolve: typeof urlResolve;
    resolveObject: typeof urlResolveObject;
    format: typeof urlFormat;
};
export default _default;
export { URLSearchParams, URL, Url, urlParse as parse, urlResolve as resolve, urlResolveObject as resolveObject, urlFormat as format, };
