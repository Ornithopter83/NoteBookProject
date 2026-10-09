const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_PAGES = 500;
const MAX_PAGE_TREE_DEPTH = 128;
const MAX_TOTAL_ITEMS = 100_000;
const MAX_TOTAL_SEGMENTS = 250_000;
const MAX_OPERANDS = 4096;
const MAX_COORDINATE = 10_000_000;

export class AiBridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'AiBridgeError'; this.code = code; }
}

const fail = (code, message) => { throw new AiBridgeError(code, message); };

/** Classify a PDF-compatible Illustrator file without claiming native AI support. */
export function inspectAi(input) {
  let bytes;
  try { bytes = toBytes(input); } catch (error) {
    const status = error.code === 'UNSUPPORTED_PDF' ? 'unsupported' : 'invalid';
    return { status, compatible: false, reason: error.message, code: error.code };
  }
  try {
    const parsed = parsePdf(bytes);
    const marker = hasAiMarker(parsed);
    return {
      status: marker ? 'pdf-compatible-ai' : 'pdf-without-ai-marker',
      compatible: marker,
      adobeCompatibility: 'unverified',
      pdfVersion: parsed.version,
      pages: parsed.pages.length,
      supportedFeatures: [...new Set(parsed.pages.flatMap(page => page.items.map(item => item.type)))],
      warnings: marker ? ['Illustrator private data is not interpreted or preserved.'] : []
    };
  } catch (error) {
    return { status: error.code === 'UNSUPPORTED_PDF' ? 'unsupported' : 'invalid', compatible: false, reason: error.message, code: error.code };
  }
}

/** Return only validated paths and ASCII text from the deliberately small PDF subset. */
export function analyzeAi(input) {
  const bytes = toBytes(input);
  const parsed = parsePdf(bytes);
  if (!hasAiMarker(parsed)) fail('NOT_AI', 'No PDF-compatible Illustrator marker was found.');
  return { format: 'pdf-compatible-ai-subset', pdfVersion: parsed.version, pages: parsed.pages };
}

/** Parse the same safe subset for ordinary PDFs, without requiring an Illustrator marker. */
export function analyzePdfSubset(input) {
  const parsed = parsePdf(toBytes(input));
  return { format: 'pdf-vector-text-subset', pdfVersion: parsed.version, pages: parsed.pages };
}

/** Apply a finite affine transform to validated geometry; text positions transform too. */
export function transformDocument(document, matrix) {
  if (!document || document.format !== 'pdf-compatible-ai-subset' || !Array.isArray(document.pages)) fail('INVALID_DOCUMENT', 'Expected a document returned by analyzeAi.');
  if (!Array.isArray(matrix) || matrix.length !== 6 || matrix.some(value => !Number.isFinite(value))) fail('INVALID_TRANSFORM', 'Transform must contain six finite numbers.');
  const [a,b,c,d,e,f] = matrix;
  const point = ([x,y]) => {
    const result = [a*x + c*y + e, b*x + d*y + f];
    if (!result.every(validCoordinate)) fail('INVALID_TRANSFORM', 'Transform produces coordinates outside the supported finite range.');
    return result.map(clean);
  };
  return {
    ...document,
    pages: document.pages.map(page => ({
      ...page,
      items: page.items.map(item => item.type === 'path'
        ? { ...item, segments: item.segments.map(segment => ({ op: segment.op, points: segment.points.map(point) })) }
        : { ...item, position: point(item.position) })
    }))
  };
}

/** Emit a fresh PDF containing only supported geometry and text. AI-private data is dropped. */
export function writePdf(document) {
  if (!document || document.format !== 'pdf-compatible-ai-subset' || !Array.isArray(document.pages) || !document.pages.length) fail('INVALID_DOCUMENT', 'Expected a non-empty analyzed document.');
  if (document.pages.length > MAX_PAGES) fail('INVALID_DOCUMENT', 'Output page count exceeds 500.');
  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  const catalog = add('');
  const pagesId = add('');
  const pageIds = [];
  const outputBudget = { items: 0, segments: 0, contentBytes: 0 };
  for (const page of document.pages) {
    if (!page || typeof page !== 'object' || !validCoordinate(page.width) || !validCoordinate(page.height) || page.width <= 0 || page.height <= 0) fail('INVALID_DOCUMENT', 'Each output page must have positive, finite dimensions within the supported range.');
    const content = serializeItems(page.items, outputBudget);
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /Font << /F1 ${add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  const chunks = ['%PDF-1.4\n%AI-Bridge-Subset\n'];
  const offsets = [0];
  let offset = Buffer.byteLength(chunks[0], 'ascii');
  objects.forEach((body, index) => {
    offsets.push(offset);
    const part = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(part); offset += Buffer.byteLength(part, 'ascii');
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  if (offset + Buffer.byteLength(xref, 'ascii') + Buffer.byteLength(trailer, 'ascii') > MAX_BYTES) fail('INVALID_DOCUMENT', 'Serialized PDF exceeds the 64 MiB output limit.');
  chunks.push(xref, trailer);
  return Buffer.from(chunks.join(''), 'ascii');
}

function toBytes(input) {
  if (Buffer.isBuffer(input)) {
    if (input.byteLength > MAX_BYTES) fail('UNSUPPORTED_PDF', 'PDF exceeds the 64 MiB safety limit.');
    return typeof SharedArrayBuffer !== 'undefined' && input.buffer instanceof SharedArrayBuffer ? Buffer.from(input) : input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_BYTES) fail('UNSUPPORTED_PDF', 'PDF exceeds the 64 MiB safety limit.');
    if (typeof SharedArrayBuffer !== 'undefined' && input.buffer instanceof SharedArrayBuffer) return Buffer.from(input);
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES) fail('UNSUPPORTED_PDF', 'PDF exceeds the 64 MiB safety limit.');
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) > 255) fail('INVALID_INPUT', 'String input must contain binary characters only; pass UTF-8 data as a Uint8Array.');
    }
    return Buffer.from(input, 'binary');
  }
  fail('INVALID_INPUT', 'Input must be a Buffer, Uint8Array, or binary string.');
}
function clean(n) { return Math.abs(n) < 1e-10 ? 0 : Number(n.toFixed(6)); }
function num(n) { if (!validCoordinate(n)) fail('INVALID_DOCUMENT', 'Number is non-finite or outside the supported coordinate range.'); return String(clean(n)); }
function validCoordinate(n) { return Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE; }

function parsePdf(bytes) {
  if (bytes.length > MAX_BYTES) fail('UNSUPPORTED_PDF', 'PDF exceeds the 64 MiB safety limit.');
  const source = bytes.toString('latin1');
  const header = source.match(/^%PDF-(1\.[4-7])(?:\r?\n)/);
  if (!header) fail('UNSUPPORTED_PDF', 'Only PDF 1.4 through 1.7 files are supported.');
  const eof = source.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!eof) fail('INVALID_PDF', 'Missing or malformed startxref/EOF.');
  const xrefOffset = Number(eof[1]);
  if (!Number.isSafeInteger(xrefOffset) || !source.startsWith('xref', xrefOffset)) fail('UNSUPPORTED_PDF', 'Classic xref tables are required; xref streams are unsupported.');
  if (source.indexOf('startxref') !== source.lastIndexOf('startxref')) fail('UNSUPPORTED_PDF', 'Incremental updates are unsupported.');
  if (/\/Encrypt\b/.test(source)) fail('UNSUPPORTED_PDF', 'Encrypted PDFs are unsupported.');
  const objects = readObjects(source);
  const trailerMatch = source.slice(xrefOffset).match(/^xref\s+0\s+(\d+)\s*\r?\n([\s\S]*?)trailer\s*(<<[\s\S]*?>>)/);
  if (!trailerMatch) fail('INVALID_PDF', 'Malformed classic xref table or trailer.');
  const xrefEntries = trailerMatch[2].split(/\r?\n/).filter(line => line.trim());
  const xrefSize = Number(trailerMatch[1]);
  if (!Number.isSafeInteger(xrefSize) || xrefSize < 2 || xrefSize > MAX_OBJECTS + 1) fail('UNSUPPORTED_PDF', 'Xref object count exceeds the supported limit.');
  if (xrefEntries.length !== xrefSize) fail('INVALID_PDF', 'Xref entry count does not match its subsection.');
  xrefEntries.forEach((line, id) => {
    const entry = /^(\d{10})\s+(\d{5})\s+([nf])\s*$/.exec(line);
    if (!entry) fail('INVALID_PDF', 'Malformed xref entry.');
    if (entry[3] === 'n') {
      const object = objects.get(id);
      if (!object || object.offset !== Number(entry[1]) || object.generation !== Number(entry[2])) fail('INVALID_PDF', `Xref entry ${id} does not point to its object.`);
    } else if (objects.has(id)) fail('INVALID_PDF', `Free xref entry ${id} has an indirect object.`);
    if (id === 0 && (entry[3] !== 'f' || Number(entry[1]) !== 0 || Number(entry[2]) !== 65535)) fail('INVALID_PDF', 'Xref object zero entry is malformed.');
  });
  const trailer = trailerMatch[3];
  if (!hasExactlyOneKey(trailer, 'Size') || !hasExactlyOneKey(trailer, 'Root')) fail('INVALID_PDF', 'Trailer must contain one direct Size and Root entry.');
  const sizeMatch = trailer.match(/\/Size\s+(\d+)/);
  if (!sizeMatch || Number(sizeMatch[1]) !== xrefSize) fail('INVALID_PDF', 'Trailer size does not match the xref subsection.');
  if (objects.size !== xrefSize - 1) fail('INVALID_PDF', 'Xref table and indirect object count do not match.');
  for (const id of objects.keys()) if (!/^\d{10}\s+\d{5}\s+n\s*$/m.test(xrefEntries[id] || '')) fail('INVALID_PDF', `Object ${id} is absent from the live xref entries.`);
  const root = trailer.match(/\/Root\s+(\d+)\s+0\s+R/);
  if (!root || !objects.has(Number(root[1]))) fail('INVALID_PDF', 'Trailer root reference is missing or unresolved.');
  const catalog = objects.get(Number(root[1])).body;
  if (!hasExactlyOneKey(catalog, 'Type') || !hasExactlyOneKey(catalog, 'Pages') || !/\/Type\s*\/Catalog\b/.test(catalog)) fail('INVALID_PDF', 'Root object is not a supported unambiguous catalog.');
  const pagesRef = catalog.match(/\/Pages\s+(\d+)\s+0\s+R/);
  if (!pagesRef) fail('UNSUPPORTED_PDF', 'Catalog has no direct page-tree reference.');
  const pages = [];
  const pageBudget = { items: 0, segments: 0 };
  visitPages(Number(pagesRef[1]), objects, pages, new Set(), pageBudget);
  if (!pages.length || pages.length > MAX_PAGES) fail('UNSUPPORTED_PDF', 'Page count is empty or exceeds 500.');
  let firstObjectOffset = source.length;
  for (const object of objects.values()) firstObjectOffset = Math.min(firstObjectOffset, object.offset);
  const markerText = source.slice(0, firstObjectOffset) + [...objects.values()].map(object => object.body).join('\n');
  return { version: header[1], source, markerText, pages };
}

function hasAiMarker(parsed) { return /(?:\/Illustrator\b|\/AIPrivateData\b|%AI[0-9])/i.test(parsed.markerText); }
function hasExactlyOneKey(dictionary, key) { return [...dictionary.matchAll(new RegExp(`/${key}\\b`, 'g'))].length === 1; }

function readObjects(source) {
  const objects = new Map(); let position = source.indexOf('\n') + 1;
  while (position < source.length) {
    while (position < source.length) {
      if (/\s/.test(source[position])) { position++; continue; }
      if (source[position] === '%') { while (position < source.length && source[position] !== '\n' && source[position] !== '\r') position++; continue; }
      break;
    }
    if (source.startsWith('xref', position) || source.startsWith('trailer', position)) break;
    const head = /^(\d+)\s+(\d+)\s+obj\s*/.exec(source.slice(position));
    if (!head) fail('INVALID_PDF', `Unexpected bytes before object at offset ${position}.`);
    const id = Number(head[1]);
    if (Number(head[2]) !== 0) fail('UNSUPPORTED_PDF', 'Only generation-zero indirect objects are supported.');
    if (objects.size >= MAX_OBJECTS) fail('UNSUPPORTED_PDF', 'Indirect object count exceeds the 100,000 object safety limit.');
    if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_OBJECTS || objects.has(id)) fail('INVALID_PDF', 'Invalid or duplicate indirect object ID.');
    const start = position + head[0].length;
    const endobj = source.indexOf('endobj', start);
    if (endobj < 0) fail('INVALID_PDF', 'Indirect object is missing endobj.');
    // Search only this object's dictionary. Searching the remaining file for
    // every non-stream object made many-object PDFs quadratic to inspect.
    const streamMatch = /\r?\nstream\r?\n/.exec(source.slice(start, endobj));
    const locatedStream = streamMatch ? start + streamMatch.index : -1;
    if (locatedStream >= 0 && (endobj < 0 || locatedStream < endobj)) {
      const dict = source.slice(start, locatedStream);
      const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (!lengthMatch || !hasExactlyOneKey(dict, 'Length')) fail('UNSUPPORTED_PDF', 'Stream lengths must be one direct integer.');
      if (/\/Filter\b/.test(dict)) fail('UNSUPPORTED_PDF', 'Filtered or compressed streams are unsupported.');
      const streamMarker = /\r?\nstream\r?\n/y;
      streamMarker.lastIndex = locatedStream;
      const marker = streamMarker.exec(source);
      const streamStart = marker.index + marker[0].length;
      const length = Number(lengthMatch[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES) fail('UNSUPPORTED_PDF', 'Stream length exceeds the supported range.');
      const streamEnd = streamStart + length;
      const endstreamStart = source.startsWith('\r\n', streamEnd) ? streamEnd + 2 : source[streamEnd] === '\n' ? streamEnd + 1 : streamEnd;
      const endstreamEnd = endstreamStart + 9;
      if (streamEnd > source.length || !source.startsWith('endstream', endstreamStart) || (source[endstreamEnd] && !/\s|[%<>()\[\]{}\/]/.test(source[endstreamEnd]))) fail('INVALID_PDF', 'Stream length does not match its endstream marker.');
      const objectEnd = source.indexOf('endobj', streamEnd);
      if (objectEnd < 0) fail('INVALID_PDF', 'Indirect object is missing endobj.');
      objects.set(id, { body: dict, stream: source.slice(streamStart, streamEnd), offset: position, generation: Number(head[2]) });
      position = objectEnd + 6;
    } else {
      if (endobj < 0) fail('INVALID_PDF', 'Indirect object is missing endobj.');
      objects.set(id, { body: source.slice(start, endobj), stream: null, offset: position, generation: Number(head[2]) });
      position = endobj + 6;
    }
  }
  if (!objects.size) fail('INVALID_PDF', 'No indirect objects found.');
  return objects;
}

function visitPages(id, objects, pages, seen, budget, depth = 0) {
  if (depth > MAX_PAGE_TREE_DEPTH) fail('UNSUPPORTED_PDF', 'Page tree nesting exceeds the supported depth limit.');
  if (seen.has(id)) fail('INVALID_PDF', 'Cycle or duplicate reference detected in page tree.');
  seen.add(id);
  const object = objects.get(id);
  if (!object) fail('INVALID_PDF', `Unresolved page-tree object ${id}.`);
  const body = object.body;
  if (/#(?:[\da-f]{2})/i.test(body)) {
    fail('UNSUPPORTED_PDF', 'Escaped names in page-tree dictionaries are unsupported.');
  }
  if (/\/(?:CropBox|BleedBox|TrimBox|ArtBox|Rotate|UserUnit|Group|Annots|OC)\b/.test(body)) {
    fail('UNSUPPORTED_PDF', 'Alternate page boxes, page rotation, page scaling, annotations, and page compositing features are unsupported.');
  }
  if (/\/Type\s*\/Page\b/.test(body)) {
    if (!hasExactlyOneKey(body, 'Type') || !hasExactlyOneKey(body, 'MediaBox') || !hasExactlyOneKey(body, 'Contents')) fail('UNSUPPORTED_PDF', 'Page dictionaries must contain one Type, MediaBox, and Contents entry.');
    const box = body.match(/\/MediaBox\s*\[([^\]]*)\]/);
    const values = box?.[1].trim().split(/\s+/) ?? [];
    if (values.length !== 4 || values.some(value => !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value))) fail('UNSUPPORTED_PDF', 'Pages must have a direct four-number MediaBox.');
    const [x0,y0,x1,y1] = values.map(Number);
    if (![x0,y0,x1,y1].every(validCoordinate) || x1 <= x0 || y1 <= y0) fail('UNSUPPORTED_PDF', 'Page MediaBox coordinates exceed the supported finite range.');
    if (x0 !== 0 || y0 !== 0) fail('UNSUPPORTED_PDF', 'Pages must use a zero-origin MediaBox.');
    if (/\/Contents\s*\[/.test(body)) fail('UNSUPPORTED_PDF', 'Each page must have exactly one direct content stream.');
    const contents = body.match(/\/Contents\s+(\d+)\s+0\s+R\b/);
    if (!contents) fail('UNSUPPORTED_PDF', 'Each page must have one direct content stream.');
    const stream = objects.get(Number(contents[1]));
    if (!stream || stream.stream === null) fail('INVALID_PDF', 'Page content stream reference is unresolved.');
    const items = parseContent(stream.stream, budget);
    if (items.some(item => item.type === 'text')) {
      if (!hasExactlyOneKey(body, 'F1')) fail('UNSUPPORTED_PDF', 'Text pages must contain exactly one F1 font resource.');
      const fontRef = body.match(/\/F1\s+(\d+)\s+0\s+R/);
      const font = fontRef && objects.get(Number(fontRef[1]));
      if (!font || !/\/Type\s*\/Font\b/.test(font.body) || !/\/BaseFont\s*\/Helvetica\b/.test(font.body) || !/\/Encoding\s*\/WinAnsiEncoding\b/.test(font.body)) fail('UNSUPPORTED_PDF', 'Text requires a directly referenced Helvetica WinAnsi F1 font.');
    }
    for (const item of items) {
      if (item.type === 'path') {
        for (const segment of item.segments) for (const point of segment.points) {
          if (!point.every(validCoordinate)) fail('UNSUPPORTED_PDF', 'Content contains non-finite or out-of-range coordinates.');
        }
      } else if (![...item.position, item.fontSize].every(validCoordinate)) fail('UNSUPPORTED_PDF', 'Content contains non-finite or out-of-range coordinates.');
    }
    pages.push({ width: x1-x0, height: y1-y0, items });
    if (pages.length > MAX_PAGES) fail('UNSUPPORTED_PDF', 'Page count exceeds 500.');
    return;
  }
  if (!hasExactlyOneKey(body, 'Type') || !hasExactlyOneKey(body, 'Kids') || !hasExactlyOneKey(body, 'Count') || !/\/Type\s*\/Pages\b/.test(body)) fail('UNSUPPORTED_PDF', 'Unsupported or ambiguous page-tree node.');
  const kids = body.match(/\/Kids\s*\[([^\]]*)\]/);
  if (!kids) fail('UNSUPPORTED_PDF', 'Page tree must have a direct Kids array.');
  const kidsContent = kids[1].trim();
  if (!/^\d+\s+0\s+R(?:\s+\d+\s+0\s+R)*$/.test(kidsContent)) fail('INVALID_PDF', 'Page tree Kids must contain only direct generation-zero references.');
  const countMatch = body.match(/\/Count\s+(\d+)\b/);
  if (!countMatch) fail('INVALID_PDF', 'Page tree node is missing its direct child count.');
  const pageCountBefore = pages.length;
  const refs = [...kidsContent.matchAll(/(\d+)\s+0\s+R/g)];
  if (!refs.length) fail('INVALID_PDF', 'Empty page-tree Kids array.');
  for (const ref of refs) visitPages(Number(ref[1]), objects, pages, seen, budget, depth + 1);
  if (Number(countMatch[1]) !== pages.length - pageCountBefore) fail('INVALID_PDF', 'Page tree child count does not match its page descendants.');
}

function tokenize(content) {
  const tokens = []; let i=0;
  while (i < content.length) {
    const ch = content[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++; continue; }
    if (ch === '(') {
      let depth=1, value=''; i++;
      while (i < content.length && depth) {
        let c=content[i++];
        if (c === '\\') { if (i >= content.length) break; c=content[i++]; const esc={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'}; value += esc[c] ?? (/[0-7]/.test(c) ? fail('UNSUPPORTED_PDF', 'Octal text escapes are unsupported.') : c); }
        else if (c === '(') { depth++; value += c; }
        else if (c === ')') { if (--depth) value += c; }
        else value += c;
      }
      if (depth) fail('INVALID_PDF', 'Unterminated PDF text string.');
      if ([...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) fail('UNSUPPORTED_PDF', 'Only printable ASCII text is supported.');
      tokens.push({type:'string', value}); continue;
    }
    if (ch === '<' && content[i+1] !== '<') {
      const end=content.indexOf('>',i+1); if(end<0) fail('INVALID_PDF','Unterminated hex string.');
      const hex=content.slice(i+1,end).replace(/\s/g,''); if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) fail('INVALID_PDF','Malformed hex string.');
      const value=Buffer.from(hex,'hex').toString('latin1'); if ([...value].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)>126)) fail('UNSUPPORTED_PDF','Only printable ASCII text is supported.');
      tokens.push({type:'string',value}); i=end+1; continue;
    }
    if (ch === '/') { let j=++i; while(i<content.length&&!/[\s()[\]<>/%]/.test(content[i]))i++; tokens.push({type:'name',value:content.slice(j,i)}); continue; }
    if ('[]'.includes(ch)) { tokens.push({type:'bracket',value:ch}); i++; continue; }
    let j=i; while(i<content.length&&!/[\s()[\]<>/%]/.test(content[i]))i++;
    if (j===i) fail('UNSUPPORTED_PDF',`Unsupported token at content offset ${i}.`);
    const value=content.slice(j,i); tokens.push({type:/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)?'number':'word',value});
    if(tokens.length>MAX_OPERANDS*20) fail('UNSUPPORTED_PDF','Content token limit exceeded.');
  }
  return tokens;
}

function parseContent(content, budget) {
  const tokens=tokenize(content), items=[], operands=[]; let current=null, textMode=false, textPos=[0,0], fontSize=12, textShownSincePositioning=false;
  const number = token => { if(!token||token.type!=='number') fail('UNSUPPORTED_PDF','Expected numeric operand.'); const value=Number(token.value); if(!validCoordinate(value)) fail('UNSUPPORTED_PDF','Coordinate is non-finite or outside the supported range.'); return value; };
  const addItem = item => { if (++budget.items > MAX_TOTAL_ITEMS) fail('UNSUPPORTED_PDF', 'Total page item count exceeds the 100,000 item safety limit.'); items.push(item); };
  const addSegments = count => { budget.segments += count; if (budget.segments > MAX_TOTAL_SEGMENTS) fail('UNSUPPORTED_PDF', 'Total path segment count exceeds the safety limit.'); };
  const flush = paint => { if(current?.segments.length && paint) addItem({type:'path',segments:current.segments,paint}); current=null; };
  for(const token of tokens) {
    if(token.type!=='word') { operands.push(token); if(operands.length>MAX_OPERANDS) fail('UNSUPPORTED_PDF','Too many operands.'); continue; }
    const op=token.value, nums=()=>operands.map(number);
    if(op==='m'||op==='l') { const v=nums(); if(v.length!==2) fail('UNSUPPORTED_PDF',`Malformed ${op} operator.`); if(op==='m'){current ??= {segments:[]};current.segments.push({op:'M',points:[[v[0],v[1]]]});}else{if(!current)fail('INVALID_PDF','Line without current path.');current.segments.push({op:'L',points:[[v[0],v[1]]]});} addSegments(1); }
    else if(op==='c') {const v=nums();if(v.length!==6||!current)fail('UNSUPPORTED_PDF','Malformed cubic curve.');current.segments.push({op:'C',points:[[v[0],v[1]],[v[2],v[3]],[v[4],v[5]]]});addSegments(1);}
    else if(op==='h') {if(operands.length||!current)fail('INVALID_PDF','Malformed close-path operator.');current.segments.push({op:'Z',points:[]});addSegments(1);}
    else if(['S','s','f','F','f*','B','B*','b','b*','n'].includes(op)) {if(operands.length)fail('UNSUPPORTED_PDF',`Unexpected operands for ${op}.`);if(op==='n')flush();else flush(op);}
    else if(op==='re') {const v=nums();if(v.length!==4)fail('UNSUPPORTED_PDF','Malformed rectangle.');current ??= {segments:[]};current.segments.push({op:'M',points:[[v[0],v[1]]]}, {op:'L',points:[[v[0]+v[2],v[1]]]}, {op:'L',points:[[v[0]+v[2],v[1]+v[3]]]}, {op:'L',points:[[v[0],v[1]+v[3]]]}, {op:'Z',points:[]});addSegments(5);}
    else if(op==='BT') {if(operands.length||textMode)fail('INVALID_PDF','Malformed text block.');flush();textMode=true;textPos=[0,0];textShownSincePositioning=false;}
    else if(op==='ET') {if(operands.length||!textMode)fail('INVALID_PDF','Malformed text block.');textMode=false;}
    else if(op==='Tf') {if(operands.length!==2||operands[0].type!=='name'||operands[0].value!=='F1')fail('UNSUPPORTED_PDF','Only the validated F1 font resource is supported.');fontSize=number(operands[1]);if(fontSize<=0||fontSize>10000)fail('INVALID_PDF','Invalid font size.');}
    else if(op==='Td'||op==='TD') {const v=nums();if(!textMode||v.length!==2)fail('UNSUPPORTED_PDF','Unsupported text positioning.');textPos=[textPos[0]+v[0],textPos[1]+v[1]];textShownSincePositioning=false;}
    else if(op==='Tm') {const v=nums();if(!textMode||v.length!==6||v[0]!==1||v[1]!==0||v[2]!==0||v[3]!==1)fail('UNSUPPORTED_PDF','Only unrotated text matrices are supported.');textPos=[v[4],v[5]];textShownSincePositioning=false;}
    else if(op==='Tj') {if(!textMode||operands.length!==1||operands[0].type!=='string')fail('UNSUPPORTED_PDF','Only simple ASCII Tj text is supported.');if(textShownSincePositioning)fail('UNSUPPORTED_PDF','Consecutive Tj text requires glyph-advance metrics, which are unsupported.');addItem({type:'text',text:operands[0].value,position:[...textPos],fontSize});textShownSincePositioning=true;}
    else if(op==='q'||op==='Q'||op==='cm'||op==='W'||op==='W*'||op==='Do'||op==='gs'||op==='sh'||op==='BI'||op==='ID'||op==='EI'||op==='TJ'||op==='T*'||op==='\''||op==='"') fail('UNSUPPORTED_PDF',`PDF operator ${op} is unsupported.`);
    else if(['w','J','j','M','G','g','RG','rg','K','k','d'].includes(op)) fail('UNSUPPORTED_PDF',`PDF graphics style operator ${op} is unsupported.`);
    else fail('UNSUPPORTED_PDF',`PDF content operator ${op} is unsupported.`);
    operands.length=0;
  }
  if(operands.length||textMode)fail('INVALID_PDF','Dangling operands or unclosed text block.');
  flush();
  return items;
}

function serializeItems(items, budget) {
  if(!Array.isArray(items)) fail('INVALID_DOCUMENT','Page items must be an array.');
  const lines=[];
  const emit = line => {
    if (budget.contentBytes + line.length + 1 > MAX_BYTES) fail('INVALID_DOCUMENT', 'Serialized page content exceeds the 64 MiB safety limit.');
    budget.contentBytes += line.length + 1;
    lines.push(line);
  };
  for(const item of items){
    if (++budget.items > MAX_TOTAL_ITEMS) fail('INVALID_DOCUMENT', 'Total page item count exceeds the 100,000 item safety limit.');
    if(item.type==='path'){
      if(!Array.isArray(item.segments)||!item.segments.length)fail('INVALID_DOCUMENT','Path has no segments.');
      for(const s of item.segments){
        if (++budget.segments > MAX_TOTAL_SEGMENTS) fail('INVALID_DOCUMENT', 'Total path segment count exceeds the safety limit.');
        if(s.op==='Z'){if(!Array.isArray(s.points)||s.points.length)fail('INVALID_DOCUMENT','Malformed close-path segment.');emit('h');continue;}
        const points=s.points;
        if(s.op==='M'||s.op==='L'){
          if(!Array.isArray(points)||points.length!==1||!Array.isArray(points[0])||points[0].length!==2)fail('INVALID_DOCUMENT','Malformed path point.');
          emit(`${num(points[0][0])} ${num(points[0][1])} ${s.op==='M'?'m':'l'}`);
        } else if(s.op==='C'){
          if(!Array.isArray(points)||points.length!==3||points.some(p=>!Array.isArray(p)||p.length!==2))fail('INVALID_DOCUMENT','Malformed cubic path.');
          emit(`${points.flat().map(num).join(' ')} c`);
        } else fail('INVALID_DOCUMENT','Unsupported path segment.');
      }
      const paints = { S:'S', s:'s', f:'f', F:'f', 'f*':'f*', B:'B', 'B*':'B*', b:'b', 'b*':'b*' };
      if (!Object.hasOwn(paints, item.paint)) fail('INVALID_DOCUMENT','Unsupported path paint operator.');
      emit(paints[item.paint]);
    } else if(item.type==='text') {
      if(typeof item.text!=='string'||!/^[\x20-\x7e]*$/.test(item.text)||!Array.isArray(item.position)||item.position.length!==2)fail('INVALID_DOCUMENT','Text must be printable ASCII with a valid position.');
      if(!Number.isFinite(item.fontSize)||item.fontSize<=0)fail('INVALID_DOCUMENT','Text font size must be positive and finite.');
      const prefix = `BT /F1 ${num(item.fontSize)} Tf 1 0 0 1 ${num(item.position[0])} ${num(item.position[1])} Tm (`;
      const suffix = ') Tj ET';
      let escapedLength = item.text.length;
      for (let i = 0; i < item.text.length; i++) if (item.text[i] === '(' || item.text[i] === ')' || item.text[i] === '\\') escapedLength++;
      if (budget.contentBytes + prefix.length + escapedLength + suffix.length + 1 > MAX_BYTES) fail('INVALID_DOCUMENT', 'Serialized page content exceeds the 64 MiB safety limit.');
      emit(`${prefix}${item.text.replace(/[()\\]/g,'\\$&')}${suffix}`);
    } else fail('INVALID_DOCUMENT','Unsupported page item.');
  }
  return lines.join('\n');
}
