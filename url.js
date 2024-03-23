// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

import { toASCII } from '@frida/punycode';
import { stringify as stringifyQuery, querystring } from '@frida/querystring';

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
const protocolPattern = /^[a-z0-9.+-]+:/i;
const portPattern = /:[0-9]*$/;
const hostPattern = /^\/\/[^@/]+@[^@/]+/;

// Special case for a simple path URL
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;

const hostnameMaxLen = 255;
// Protocols that can allow "unsafe" and "unwise" chars.
const unsafeProtocol = new Set([
  'javascript',
  'javascript:',
]);
// Protocols that never have a hostname.
const hostlessProtocol = new Set([
  'javascript',
  'javascript:',
]);
// Protocols that always contain a // bit.
const slashedProtocol = new Set([
  'http',
  'http:',
  'https',
  'https:',
  'ftp',
  'ftp:',
  'gopher',
  'gopher:',
  'file',
  'file:',
  'ws',
  'ws:',
  'wss',
  'wss:',
]);
const
  CHAR_SPACE = 32,
  CHAR_TAB = 9,
  CHAR_CARRIAGE_RETURN = 13,
  CHAR_LINE_FEED = 10,
  CHAR_FORM_FEED = 12,
  CHAR_NO_BREAK_SPACE = 160,
  CHAR_ZERO_WIDTH_NOBREAK_SPACE = 65279,
  CHAR_HASH = 35,
  CHAR_FORWARD_SLASH = 47,
  CHAR_LEFT_SQUARE_BRACKET = 91,
  CHAR_RIGHT_SQUARE_BRACKET = 93,
  CHAR_LEFT_ANGLE_BRACKET = 60,
  CHAR_RIGHT_ANGLE_BRACKET = 62,
  CHAR_LEFT_CURLY_BRACKET = 123,
  CHAR_RIGHT_CURLY_BRACKET = 125,
  CHAR_QUESTION_MARK = 63,
  CHAR_LOWERCASE_A = 97,
  CHAR_LOWERCASE_Z = 122,
  CHAR_UPPERCASE_A = 65,
  CHAR_UPPERCASE_Z = 90,
  CHAR_DOT = 46,
  CHAR_0 = 48,
  CHAR_9 = 57,
  CHAR_HYPHEN_MINUS = 45,
  CHAR_PLUS = 43,
  CHAR_UNDERSCORE = 95,
  CHAR_DOUBLE_QUOTE = 34,
  CHAR_SINGLE_QUOTE = 39,
  CHAR_PERCENT = 37,
  CHAR_SEMICOLON = 59,
  CHAR_BACKWARD_SLASH = 92,
  CHAR_CIRCUMFLEX_ACCENT = 94,
  CHAR_GRAVE_ACCENT = 96,
  CHAR_VERTICAL_LINE = 124,
  CHAR_AT = 64;

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url instanceof Url) return url;

  const urlObject = new Url();
  urlObject.parse(url, parseQueryString, slashesDenoteHost);
  return urlObject;
}

function isIpv6Hostname(hostname) {
  return (
    hostname.charCodeAt(0) === CHAR_LEFT_SQUARE_BRACKET &&
    hostname.charCodeAt(hostname.length - 1) === CHAR_RIGHT_SQUARE_BRACKET
  );
}

// This prevents some common spoofing bugs due to our use of IDNA toASCII. For
// compatibility, the set of characters we use here is the *intersection* of
// "forbidden host code point" in the WHATWG URL Standard [1] and the
// characters in the host parsing loop in Url.prototype.parse, with the
// following additions:
//
// - ':' since this could cause a "protocol spoofing" bug
// - '@' since this could cause parts of the hostname to be confused with auth
// - '[' and ']' since this could cause a non-IPv6 hostname to be interpreted
//   as IPv6 by isIpv6Hostname above
//
// [1]: https://url.spec.whatwg.org/#forbidden-host-code-point
const forbiddenHostChars = /[\t\n\r #%/:<>?@[\\\]^|]/;

Url.prototype.parse = function parse(url, parseQueryString, slashesDenoteHost) {
  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  let hasHash = false;
  let start = -1;
  let end = -1;
  let rest = '';
  let lastPos = 0;
  for (let i = 0, inWs = false, split = false; i < url.length; ++i) {
    const code = url.charCodeAt(i);

    // Find first and last non-whitespace characters for trimming
    const isWs = code === CHAR_SPACE ||
                 code === CHAR_TAB ||
                 code === CHAR_CARRIAGE_RETURN ||
                 code === CHAR_LINE_FEED ||
                 code === CHAR_FORM_FEED ||
                 code === CHAR_NO_BREAK_SPACE ||
                 code === CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs)
        continue;
      lastPos = start = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    // Only convert backslashes while we haven't seen a split character
    if (!split) {
      switch (code) {
        case CHAR_HASH:
          hasHash = true;
        // Fall through
        case CHAR_QUESTION_MARK:
          split = true;
          break;
        case CHAR_BACKWARD_SLASH:
          if (i - lastPos > 0)
            rest += url.slice(lastPos, i);
          rest += '/';
          lastPos = i + 1;
          break;
      }
    } else if (!hasHash && code === CHAR_HASH) {
      hasHash = true;
    }
  }

  // Check if string was non-empty (including strings with only whitespace)
  if (start !== -1) {
    if (lastPos === start) {
      // We didn't convert any backslashes

      if (end === -1) {
        if (start === 0)
          rest = url;
        else
          rest = url.slice(start);
      } else {
        rest = url.slice(start, end);
      }
    } else if (end === -1 && lastPos < url.length) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos);
    } else if (end !== -1 && lastPos < end) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos, end);
    }
  }

  if (!slashesDenoteHost && !hasHash) {
    // Try fast path regexp
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.slice(1));
        } else {
          this.query = this.search.slice(1);
        }
      } else if (parseQueryString) {
        this.search = null;
        this.query = Object.create(null);
      }
      return this;
    }
  }

  let proto = protocolPattern.exec(rest);
  let lowerProto;
  if (proto) {
    proto = proto[0];
    lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.slice(proto.length);
  }

  // Figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  let slashes;
  if (slashesDenoteHost || proto || hostPattern.test(rest)) {
    slashes = rest.charCodeAt(0) === CHAR_FORWARD_SLASH &&
              rest.charCodeAt(1) === CHAR_FORWARD_SLASH;
    if (slashes && !(proto && hostlessProtocol.has(lowerProto))) {
      rest = rest.slice(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol.has(lowerProto) &&
      (slashes || (proto && !slashedProtocol.has(proto)))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:b path:/?@c

    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < rest.length; ++i) {
      switch (rest.charCodeAt(i)) {
        case CHAR_TAB:
        case CHAR_LINE_FEED:
        case CHAR_CARRIAGE_RETURN:
        case CHAR_SPACE:
        case CHAR_DOUBLE_QUOTE:
        case CHAR_PERCENT:
        case CHAR_SINGLE_QUOTE:
        case CHAR_SEMICOLON:
        case CHAR_LEFT_ANGLE_BRACKET:
        case CHAR_RIGHT_ANGLE_BRACKET:
        case CHAR_BACKWARD_SLASH:
        case CHAR_CIRCUMFLEX_ACCENT:
        case CHAR_GRAVE_ACCENT:
        case CHAR_LEFT_CURLY_BRACKET:
        case CHAR_VERTICAL_LINE:
        case CHAR_RIGHT_CURLY_BRACKET:
          // Characters that are never ever allowed in a hostname from RFC 2396
          if (nonHost === -1)
            nonHost = i;
          break;
        case CHAR_HASH:
        case CHAR_FORWARD_SLASH:
        case CHAR_QUESTION_MARK:
          // Find the first instance of any host-ending characters
          if (nonHost === -1)
            nonHost = i;
          hostEnd = i;
          break;
        case CHAR_AT:
          // At this point, either we have an explicit point where the
          // auth portion cannot go past, or the last @ char is the decider.
          atSign = i;
          nonHost = -1;
          break;
      }
      if (hostEnd !== -1)
        break;
    }
    start = 0;
    if (atSign !== -1) {
      this.auth = decodeURIComponent(rest.slice(0, atSign));
      start = atSign + 1;
    }
    if (nonHost === -1) {
      this.host = rest.slice(start);
      rest = '';
    } else {
      this.host = rest.slice(start, nonHost);
      rest = rest.slice(nonHost);
    }

    // pull out port.
    this.parseHost();

    // We've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    if (typeof this.hostname !== 'string')
      this.hostname = '';

    const hostname = this.hostname;

    // If hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    const ipv6Hostname = isIpv6Hostname(hostname);

    // validate a little.
    if (!ipv6Hostname) {
      rest = getHostname(this, rest, hostname);
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // Hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname && this.hostname !== '') {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.

      // Use lenient mode (`true`) to try to support even non-compliant
      // URLs.
      this.hostname = toASCII(this.hostname, true);

      // Prevent two potential routes of hostname spoofing.
      // 1. If this.hostname is empty, it must have become empty due to toASCII
      //    since we checked this.hostname above.
      // 2. If any of forbiddenHostChars appears in this.hostname, it must have
      //    also gotten in due to toASCII. This is since getHostname would have
      //    filtered them out otherwise.
      // Rather than trying to correct this by moving the non-host part into
      // the pathname as we've done in getHostname, throw an exception to
      // convey the severity of this issue.
      if (this.hostname === '' || forbiddenHostChars.test(this.hostname)) {
        throw new Error('invalid URL');
      }
    }

    const p = this.port ? ':' + this.port : '';
    const h = this.hostname || '';
    this.host = h + p;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.slice(1, -1);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // Now rest is set to the post-host stuff.
  // Chop off any delim chars.
  if (!unsafeProtocol.has(lowerProto)) {
    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    rest = autoEscapeStr(rest);
  }

  let questionIdx = -1;
  let hashIdx = -1;
  for (let i = 0; i < rest.length; ++i) {
    const code = rest.charCodeAt(i);
    if (code === CHAR_HASH) {
      this.hash = rest.slice(i);
      hashIdx = i;
      break;
    } else if (code === CHAR_QUESTION_MARK && questionIdx === -1) {
      questionIdx = i;
    }
  }

  if (questionIdx !== -1) {
    if (hashIdx === -1) {
      this.search = rest.slice(questionIdx);
      this.query = rest.slice(questionIdx + 1);
    } else {
      this.search = rest.slice(questionIdx, hashIdx);
      this.query = rest.slice(questionIdx + 1, hashIdx);
    }
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
  } else if (parseQueryString) {
    // No query string, but parseQueryString still requested
    this.search = null;
    this.query = Object.create(null);
  }

  const useQuestionIdx =
    questionIdx !== -1 && (hashIdx === -1 || questionIdx < hashIdx);
  const firstIdx = useQuestionIdx ? questionIdx : hashIdx;
  if (firstIdx === -1) {
    if (rest.length > 0)
      this.pathname = rest;
  } else if (firstIdx > 0) {
    this.pathname = rest.slice(0, firstIdx);
  }
  if (slashedProtocol.has(lowerProto) &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  // To support http.request
  if (this.pathname || this.search) {
    const p = this.pathname || '';
    const s = this.search || '';
    this.path = p + s;
  }

  // Finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

function getHostname(self, rest, hostname) {
  for (let i = 0; i < hostname.length; ++i) {
    const code = hostname.charCodeAt(i);
    const isValid = (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z) ||
                    code === CHAR_DOT ||
                    (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
                    (code >= CHAR_0 && code <= CHAR_9) ||
                    code === CHAR_HYPHEN_MINUS ||
                    code === CHAR_PLUS ||
                    code === CHAR_UNDERSCORE ||
                    code > 127;

    // Invalid host character
    if (!isValid) {
      self.hostname = hostname.slice(0, i);
      return `/${hostname.slice(i)}${rest}`;
    }
  }
  return rest;
}

// Escaped characters. Use empty strings to fill up unused entries.
// Using Array is faster than Object/Map
const escapedCodes = [
  /* 0 - 9 */ '', '', '', '', '', '', '', '', '', '%09',
  /* 10 - 19 */ '%0A', '', '', '%0D', '', '', '', '', '', '',
  /* 20 - 29 */ '', '', '', '', '', '', '', '', '', '',
  /* 30 - 39 */ '', '', '%20', '', '%22', '', '', '', '', '%27',
  /* 40 - 49 */ '', '', '', '', '', '', '', '', '', '',
  /* 50 - 59 */ '', '', '', '', '', '', '', '', '', '',
  /* 60 - 69 */ '%3C', '', '%3E', '', '', '', '', '', '', '',
  /* 70 - 79 */ '', '', '', '', '', '', '', '', '', '',
  /* 80 - 89 */ '', '', '', '', '', '', '', '', '', '',
  /* 90 - 99 */ '', '', '%5C', '', '%5E', '', '%60', '', '', '',
  /* 100 - 109 */ '', '', '', '', '', '', '', '', '', '',
  /* 110 - 119 */ '', '', '', '', '', '', '', '', '', '',
  /* 120 - 125 */ '', '', '', '%7B', '%7C', '%7D',
];

// Automatically escape all delimiters and unwise characters from RFC 2396.
// Also escape single quotes in case of an XSS attack.
// Return the escaped string.
function autoEscapeStr(rest) {
  let escaped = '';
  let lastEscapedPos = 0;
  for (let i = 0; i < rest.length; ++i) {
    // `escaped` contains substring up to the last escaped character.
    const escapedChar = escapedCodes[rest.charCodeAt(i)];
    if (escapedChar) {
      // Concat if there are ordinary characters in the middle.
      if (i > lastEscapedPos)
        escaped += rest.slice(lastEscapedPos, i);
      escaped += escapedChar;
      lastEscapedPos = i + 1;
    }
  }
  if (lastEscapedPos === 0)  // Nothing has been escaped.
    return rest;

  // There are ordinary characters at the end.
  if (lastEscapedPos < rest.length)
    escaped += rest.slice(lastEscapedPos);

  return escaped;
}

// Format a parsed object into a url string
function urlFormat(urlObject, options) {
  // Ensure it's an object, and not a string url.
  // If it's an object, this is a no-op.
  // this way, you can call urlParse() on strings
  // to clean up potentially wonky urls.
  if (typeof urlObject === 'string') {
    urlObject = urlParse(urlObject);
  } else if (typeof urlObject !== 'object' || urlObject === null) {
    throw new Error('invalid argument type');
  } else if (!(urlObject instanceof Url)) {
    return Url.prototype.format.call(urlObject);
  }
  return urlObject.format();
}

// These characters do not need escaping:
// ! - . _ ~
// ' ( ) * :
// digits
// alpha (uppercase)
// alpha (lowercase)
const noEscapeAuth = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x00 - 0x0F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0x10 - 0x1F
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 0x20 - 0x2F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // 0x30 - 0x3F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x40 - 0x4F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 0x50 - 0x5F
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 0x60 - 0x6F
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0,  // 0x70 - 0x7F
]);

Url.prototype.format = function format() {
  let auth = this.auth || '';
  if (auth) {
    auth = encodeStr(auth, noEscapeAuth, hexTable);
    auth += '@';
  }

  let protocol = this.protocol || '';
  let pathname = this.pathname || '';
  let hash = this.hash || '';
  let host = '';
  let query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (
      this.hostname.includes(':') && !isIpv6Hostname(this.hostname) ?
        '[' + this.hostname + ']' :
        this.hostname
    );
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query !== null && typeof this.query === 'object') {
    query = querystring.stringify(this.query);
  }

  let search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.charCodeAt(protocol.length - 1) !== 58/* : */)
    protocol += ':';

  let newPathname = '';
  let lastPos = 0;
  for (let i = 0; i < pathname.length; ++i) {
    switch (pathname.charCodeAt(i)) {
      case CHAR_HASH:
        if (i - lastPos > 0)
          newPathname += pathname.slice(lastPos, i);
        newPathname += '%23';
        lastPos = i + 1;
        break;
      case CHAR_QUESTION_MARK:
        if (i - lastPos > 0)
          newPathname += pathname.slice(lastPos, i);
        newPathname += '%3F';
        lastPos = i + 1;
        break;
    }
  }
  if (lastPos > 0) {
    if (lastPos !== pathname.length)
      pathname = newPathname + pathname.slice(lastPos);
    else
      pathname = newPathname;
  }

  // Only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes || slashedProtocol.has(protocol)) {
    if (this.slashes || host) {
      if (pathname && pathname.charCodeAt(0) !== CHAR_FORWARD_SLASH)
        pathname = '/' + pathname;
      host = '//' + host;
    } else if (protocol.length >= 4 &&
               protocol.charCodeAt(0) === 102/* f */ &&
               protocol.charCodeAt(1) === 105/* i */ &&
               protocol.charCodeAt(2) === 108/* l */ &&
               protocol.charCodeAt(3) === 101/* e */) {
      host = '//';
    }
  }

  search = search.replace(/#/g, '%23');

  if (hash && hash.charCodeAt(0) !== CHAR_HASH)
    hash = '#' + hash;
  if (search && search.charCodeAt(0) !== CHAR_QUESTION_MARK)
    search = '?' + search;

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function resolve(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function resolveObject(relative) {
  if (typeof relative === 'string') {
    const rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  const result = new Url();
  const tkeys = Object.keys(this);
  for (let tk = 0; tk < tkeys.length; tk++) {
    const tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // Hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // If the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // Hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // Take everything except the protocol from relative
    const rkeys = Object.keys(relative);
    for (let rk = 0; rk < rkeys.length; rk++) {
      const rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    // urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol.has(result.protocol) &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // If it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol.has(relative.protocol)) {
      const keys = Object.keys(relative);
      for (let v = 0; v < keys.length; v++) {
        const k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host &&
        !/^file:?$/.test(relative.protocol) &&
        !hostlessProtocol.has(relative.protocol)) {
      const relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // To support http.request
    if (result.pathname || result.search) {
      const p = result.pathname || '';
      const s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  const isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/');
  const isRelAbs = (
    relative.host || (relative.pathname && relative.pathname.charAt(0) === '/')
  );
  let mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname));
  const removeAllDots = mustEndAbs;
  let srcPath = (result.pathname && result.pathname.split('/')) || [];
  const relPath = (relative.pathname && relative.pathname.split('/')) || [];
  const noLeadingSlashes = result.protocol &&
      !slashedProtocol.has(result.protocol);

  // If the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (noLeadingSlashes) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    if (relative.host || relative.host === '') {
      if (result.host !== relative.host) result.auth = null;
      result.host = relative.host;
      result.port = relative.port;
    }
    if (relative.hostname || relative.hostname === '') {
      if (result.hostname !== relative.hostname) result.auth = null;
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // Fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search !== null && relative.search !== undefined) {
    // Just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (noLeadingSlashes) {
      result.hostname = result.host = srcPath.shift();
      // Occasionally the auth can get stuck only in host.
      // This especially happens in cases like
      // url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      const authInHost =
        result.host && result.host.indexOf('@') > 0 && result.host.split('@');
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    // To support http.request
    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // No path at all. All other things were already handled above.
    result.pathname = null;
    // To support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // If a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  let last = srcPath.slice(-1)[0];
  const hasTrailingSlash = (
    ((result.host || relative.host || srcPath.length > 1) &&
    (last === '.' || last === '..')) || last === '');

  // Strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  let up = 0;
  for (let i = srcPath.length - 1; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      spliceOne(srcPath, i);
    } else if (last === '..') {
      spliceOne(srcPath, i);
      up++;
    } else if (up) {
      spliceOne(srcPath, i);
      up--;
    }
  }

  // If the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    while (up--) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  const isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (noLeadingSlashes) {
    result.hostname =
      result.host = isAbsolute ? '' : srcPath.length ? srcPath.shift() : '';
    // Occasionally the auth can get stuck only in host.
    // This especially happens in cases like
    // url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    const authInHost = result.host && result.host.indexOf('@') > 0 ?
      result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  // To support request.http
  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function parseHost() {
  let host = this.host;
  let port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.slice(1);
    }
    host = host.slice(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

// As of V8 6.6, depending on the size of the array, this is anywhere
// between 1.5-10x faster than the two-arg version of Array#splice()
function spliceOne(list, index) {
  for (; index + 1 < list.length; index++)
    list[index] = list[index + 1];
  list.pop();
}

// Class representing URL search parameters
class URLSearchParams {
  constructor(queryString) {
    // If queryString is null or undefined, set it to an empty string
    if (queryString === null || queryString === undefined) {
      queryString = '';
    }
    // Parse the query string into key-value pairs
    this.params = URLSearchParams.parse(queryString);
  }

  // Static method to parse the query string
  static parse(queryString) {
    // Use Map instead of URLSearchParams
    const params = new Map();
    if (queryString) {
      // Split the query string into individual parameters and iterate over them
      queryString
        .replace(/\+/g, ' ') // Replace '+' with space
        .split('&') // Split parameters using '&' as delimiter
        .forEach((param) => {
          // Split each parameter into key and value
          const [key, value] = param.split('=');
          // Decode the key and value
          const decodedKey = decodeURIComponent(key);
          const decodedValue = decodeURIComponent(value || '');
          // Check if the parameter already exists in the params Map
          if (!params.has(decodedKey)) {
            // If not, append it
            params.append(decodedKey, decodedValue);
          } else {
            // If yes, set its value
            params.set(decodedKey, decodedValue);
          }
        });
    }
    return params;
  }

  // Method to check if a parameter exists
  has(key) {
    return this.params.has(key);
  }

  // Method to get the value of a parameter
  get(key) {
    return this.params.get(key);
  }

  // Method to set the value of a parameter
  set(key, value) {
    this.params.set(key, value);
  }

  // Method to append a new value to a parameter
  append(key, value) {
    this.params.append(key, value);
  }

  // Method to delete a parameter
  delete(key) {
    this.params.delete(key);
  }

  // Method to convert the parameters back to a query string
  toString() {
    let queryString = '';
    // Iterate over the params Map and construct the query string
    this.params.forEach((value, key) => {
      if (queryString !== '') {
        queryString += '&';
      }
      queryString += encodeURIComponent(key) + '=' + encodeURIComponent(value);
    });
    return queryString;
  }
}

// Class representing a URL
class URL {
  constructor(urlString, base) {
    // Throw error if urlString is not a string
    if (typeof urlString !== 'string') {
        throw new Error('Invalid URL string');
    }
    // Parse the URL string into its components
    const urlObject = urlParse(urlString, true, true);
    // Assign each component to instance variables
    this._protocol = urlObject.protocol;
    this._slashes = urlObject.slashes;
    this._auth = urlObject.auth;
    this._hostname = urlObject.hostname;
    this._port = urlObject.port;
    this._host = urlObject.host;
    this._pathname = urlObject.pathname;
    this._search = urlObject.search;
    this._query = urlObject.query;
    this._hash = urlObject.hash;
    this._path = urlObject.path;
    this._href = urlObject.href;
    // Create URLSearchParams object from query object
    this._searchParams = new URLSearchParams(stringifyQuery(this._query));
    // If a base URL is provided, override the host component
    if (base) {
      this._host = base;
    }
  }

  // Method to convert URL object back to a string
  toString() {
    return this._href;
  }

  // Getter for the base URL
  get base() {
    return this._host;
  }

  // Getters for various URL components
  get protocol() {
    return this._protocol;
  }

  // Getter for slashes
  get slashes() {
    return this._slashes;
  }

  // Getter for authentication information
  get auth() {
    return this._auth;
  }

  // Getter for hostname
  get hostname() {
    return this._hostname;
  }

  // Getter for port number
  get port() {
    return this._port;
  }

  // Getter for host
  get host() {
    return this._host;
  }

  // Getter for pathname
  get pathname() {
    return this._pathname;
  }

  // Getter for search query
  get search() {
    return this._search;
  }

  // Getter for query string parameters
  get query() {
    return this._query;
  }

  // Getter for hash
  get hash() {
    return this._hash;
  }

  // Getter for path
  get path() {
    return this._path;
  }

  // Getter for href
  get href() {
    return this._href;
  }

  // Getter for URL search parameters
  get searchParams() {
    return this._searchParams;
  }
}

export default {
  URLSearchParams,
  URL,
  Url,
  parse: urlParse,
  resolve: urlResolve,
  resolveObject: urlResolveObject,
  format: urlFormat,
};
export {
  URLSearchParams,
  URL,
  Url,
  urlParse as parse,
  urlResolve as resolve,
  urlResolveObject as resolveObject,
  urlFormat as format,
};
