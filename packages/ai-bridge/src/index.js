const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_PAGES = 500;
const MAX_OPERANDS = 4096;

export class AiBridgeError extends Error {
  constructor(code, message) { super(message); this.name = 'AiBridgeError'; this.code = code; }
}

const fail = (code, message) => { throw new AiBridgeError(code, message); };

/** Classify a PDF-compatible Illustrator file without claiming native AI support. */
export function inspectAi(input) {
  let bytes;
  try { bytes = toBytes(input); } catch (error) { return { status: 'invalid', compatible: false, reason: error.message }; }
  try {
    const parsed = parsePdf(bytes);
    const marker = hasAiMarker(parsed);
    return {
      status: marker ? 'pdf-compatible-ai' : 'pdf-without-ai-marker',
      compatible: marker,
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
  const point = ([x,y]) => [clean(a*x + c*y + e), clean(b*x + d*y + f)];
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
  for (const page of document.pages) {
    const content = serializeItems(page.items);
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
  chunks.push(xref, `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'ascii');
}

function toBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'binary');
  fail('INVALID_INPUT', 'Input must be a Buffer, Uint8Array, or binary string.');
}
function clean(n) { return Math.abs(n) < 1e-10 ? 0 : Number(n.toFixed(6)); }
function num(n) { if (!Number.isFinite(n)) fail('INVALID_DOCUMENT', 'Non-finite number in document.'); return String(clean(n)); }

function parsePdf(bytes) {
  if (bytes.length > MAX_BYTES) fail('UNSUPPORTED_PDF', 'PDF exceeds the 64 MiB safety limit.');
  const source = bytes.toString('latin1');
  const header = source.match(/^%PDF-(1\.[4-7])(?:\r?\n)/);
  if (!header) fail('UNSUPPORTED_PDF', 'Only PDF 1.4 through 1.7 files are supported.');
  const eof = source.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!eof) fail('INVALID_PDF', 'Missing or malformed startxref/EOF.');
  const xrefOffset = Number(eof[1]);
  if (!Number.isSafeInteger(xrefOffset) || !source.startsWith('xref', xrefOffset)) fail('UNSUPPORTED_PDF', 'Classic xref tables are required; xref streams are unsupported.');
  if (/\/Encrypt\b/.test(source)) fail('UNSUPPORTED_PDF', 'Encrypted PDFs are unsupported.');
  const objects = readObjects(source);
  const trailerMatch = source.slice(xrefOffset).match(/^xref\s+0\s+(\d+)\s*\r?\n([\s\S]*?)trailer\s*(<<[\s\S]*?>>)/);
  if (!trailerMatch) fail('INVALID_PDF', 'Malformed classic xref table or trailer.');
  const xrefEntries = trailerMatch[2].split(/\r?\n/).filter(line => line.trim());
  if (xrefEntries.length !== Number(trailerMatch[1])) fail('INVALID_PDF', 'Xref entry count does not match its subsection.');
  xrefEntries.forEach((line, id) => {
    const entry = /^(\d{10})\s+(\d{5})\s+([nf])\s*$/.exec(line);
    if (!entry) fail('INVALID_PDF', 'Malformed xref entry.');
    if (entry[3] === 'n') {
      const object = objects.get(id);
      if (!object || object.offset !== Number(entry[1]) || object.generation !== Number(entry[2])) fail('INVALID_PDF', `Xref entry ${id} does not point to its object.`);
    }
  });
  const trailer = trailerMatch[3];
  const root = trailer.match(/\/Root\s+(\d+)\s+0\s+R/);
  if (!root || !objects.has(Number(root[1]))) fail('INVALID_PDF', 'Trailer root reference is missing or unresolved.');
  const catalog = objects.get(Number(root[1])).body;
  if (!/\/Type\s*\/Catalog\b/.test(catalog)) fail('INVALID_PDF', 'Root object is not a catalog.');
  const pagesRef = catalog.match(/\/Pages\s+(\d+)\s+0\s+R/);
  if (!pagesRef) fail('UNSUPPORTED_PDF', 'Catalog has no direct page-tree reference.');
  const pages = [];
  visitPages(Number(pagesRef[1]), objects, pages, new Set());
  if (!pages.length || pages.length > MAX_PAGES) fail('UNSUPPORTED_PDF', 'Page count is empty or exceeds 500.');
  const firstObjectOffset = Math.min(...[...objects.values()].map(object => object.offset));
  const markerText = source.slice(0, firstObjectOffset) + [...objects.values()].map(object => object.body).join('\n');
  return { version: header[1], source, markerText, pages };
}

function hasAiMarker(parsed) { return /(?:\/Illustrator\b|\/AIPrivateData\b|%AI[0-9])/i.test(parsed.markerText); }

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
    if (objects.size >= MAX_OBJECTS || objects.has(id)) fail('INVALID_PDF', 'Object count limit exceeded or duplicate object ID found.');
    const start = position + head[0].length;
    const streamMatch = /\r?\nstream\r?\n/.exec(source.slice(start));
    const locatedStream = streamMatch ? start + streamMatch.index : -1;
    const endobj = source.indexOf('endobj', start);
    if (locatedStream >= 0 && (endobj < 0 || locatedStream < endobj)) {
      const dict = source.slice(start, locatedStream);
      const lengthMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (!lengthMatch) fail('UNSUPPORTED_PDF', 'Stream lengths must be direct integers.');
      if (/\/Filter\b/.test(dict)) fail('UNSUPPORTED_PDF', 'Filtered or compressed streams are unsupported.');
      const streamMarker = /\r?\nstream\r?\n/y;
      streamMarker.lastIndex = locatedStream;
      const marker = streamMarker.exec(source);
      const streamStart = marker.index + marker[0].length;
      const length = Number(lengthMatch[1]);
      const streamEnd = streamStart + length;
      if (streamEnd > source.length || source.slice(streamEnd, streamEnd + 10).replace(/^\r?\n/, '').slice(0, 9) !== 'endstream') fail('INVALID_PDF', 'Stream length does not match its endstream marker.');
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

function visitPages(id, objects, pages, seen) {
  if (seen.has(id)) fail('INVALID_PDF', 'Cycle detected in page tree.');
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
    const box = body.match(/\/MediaBox\s*\[\s*([-+\d.]+)\s+([-+\d.]+)\s+([-+\d.]+)\s+([-+\d.]+)\s*\]/);
    if (!box) fail('UNSUPPORTED_PDF', 'Pages must have a direct MediaBox.');
    const [x0,y0,x1,y1] = box.slice(1).map(Number);
    if (![x0,y0,x1,y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) fail('INVALID_PDF', 'Invalid page MediaBox.');
    if (x0 !== 0 || y0 !== 0) fail('UNSUPPORTED_PDF', 'Pages must use a zero-origin MediaBox.');
    const contents = body.match(/\/Contents\s+(\d+)\s+0\s+R/);
    if (!contents) fail('UNSUPPORTED_PDF', 'Each page must have one direct content stream.');
    const stream = objects.get(Number(contents[1]));
    if (!stream || stream.stream === null) fail('INVALID_PDF', 'Page content stream reference is unresolved.');
    const items = parseContent(stream.stream);
    if (items.some(item => item.type === 'text')) {
      const fontRef = body.match(/\/F1\s+(\d+)\s+0\s+R/);
      const font = fontRef && objects.get(Number(fontRef[1]));
      if (!font || !/\/Type\s*\/Font\b/.test(font.body) || !/\/BaseFont\s*\/Helvetica\b/.test(font.body) || !/\/Encoding\s*\/WinAnsiEncoding\b/.test(font.body)) fail('UNSUPPORTED_PDF', 'Text requires a directly referenced Helvetica WinAnsi F1 font.');
    }
    pages.push({ width: x1-x0, height: y1-y0, items });
    return;
  }
  if (!/\/Type\s*\/Pages\b/.test(body)) fail('UNSUPPORTED_PDF', 'Unsupported page-tree node.');
  const kids = body.match(/\/Kids\s*\[([^\]]*)\]/);
  if (!kids) fail('UNSUPPORTED_PDF', 'Page tree must have a direct Kids array.');
  const refs = [...kids[1].matchAll(/(\d+)\s+0\s+R/g)];
  if (!refs.length) fail('INVALID_PDF', 'Empty page-tree Kids array.');
  for (const ref of refs) visitPages(Number(ref[1]), objects, pages, seen);
  seen.delete(id);
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

function parseContent(content) {
  const tokens=tokenize(content), items=[], operands=[]; let current=null, textMode=false, textPos=[0,0], fontSize=12, textShownSincePositioning=false;
  const number = token => { if(!token||token.type!=='number') fail('UNSUPPORTED_PDF','Expected numeric operand.'); const value=Number(token.value); if(!Number.isFinite(value)) fail('INVALID_PDF','Non-finite coordinate.'); return value; };
  const flush = paint => { if(current?.segments.length && paint) items.push({type:'path',segments:current.segments,paint}); current=null; };
  for(const token of tokens) {
    if(token.type!=='word') { operands.push(token); if(operands.length>MAX_OPERANDS) fail('UNSUPPORTED_PDF','Too many operands.'); continue; }
    const op=token.value, nums=()=>operands.map(number);
    if(op==='m'||op==='l') { const v=nums(); if(v.length!==2) fail('UNSUPPORTED_PDF',`Malformed ${op} operator.`); if(op==='m'){current ??= {segments:[]};current.segments.push({op:'M',points:[[v[0],v[1]]]});}else{if(!current)fail('INVALID_PDF','Line without current path.');current.segments.push({op:'L',points:[[v[0],v[1]]]});} }
    else if(op==='c') {const v=nums();if(v.length!==6||!current)fail('UNSUPPORTED_PDF','Malformed cubic curve.');current.segments.push({op:'C',points:[[v[0],v[1]],[v[2],v[3]],[v[4],v[5]]]});}
    else if(op==='h') {if(operands.length||!current)fail('INVALID_PDF','Malformed close-path operator.');current.segments.push({op:'Z',points:[]});}
    else if(['S','s','f','F','f*','B','B*','b','b*','n'].includes(op)) {if(operands.length)fail('UNSUPPORTED_PDF',`Unexpected operands for ${op}.`);if(op==='n')flush();else flush(op);}
    else if(op==='re') {const v=nums();if(v.length!==4)fail('UNSUPPORTED_PDF','Malformed rectangle.');current ??= {segments:[]};current.segments.push({op:'M',points:[[v[0],v[1]]]}, {op:'L',points:[[v[0]+v[2],v[1]]]}, {op:'L',points:[[v[0]+v[2],v[1]+v[3]]]}, {op:'L',points:[[v[0],v[1]+v[3]]]}, {op:'Z',points:[]});}
    else if(op==='BT') {if(operands.length||textMode)fail('INVALID_PDF','Malformed text block.');flush();textMode=true;textPos=[0,0];textShownSincePositioning=false;}
    else if(op==='ET') {if(operands.length||!textMode)fail('INVALID_PDF','Malformed text block.');textMode=false;}
    else if(op==='Tf') {if(operands.length!==2||operands[0].type!=='name'||operands[0].value!=='F1')fail('UNSUPPORTED_PDF','Only the validated F1 font resource is supported.');fontSize=number(operands[1]);if(fontSize<=0||fontSize>10000)fail('INVALID_PDF','Invalid font size.');}
    else if(op==='Td'||op==='TD') {const v=nums();if(!textMode||v.length!==2)fail('UNSUPPORTED_PDF','Unsupported text positioning.');textPos=[textPos[0]+v[0],textPos[1]+v[1]];textShownSincePositioning=false;}
    else if(op==='Tm') {const v=nums();if(!textMode||v.length!==6||v[0]!==1||v[1]!==0||v[2]!==0||v[3]!==1)fail('UNSUPPORTED_PDF','Only unrotated text matrices are supported.');textPos=[v[4],v[5]];textShownSincePositioning=false;}
    else if(op==='Tj') {if(!textMode||operands.length!==1||operands[0].type!=='string')fail('UNSUPPORTED_PDF','Only simple ASCII Tj text is supported.');if(textShownSincePositioning)fail('UNSUPPORTED_PDF','Consecutive Tj text requires glyph-advance metrics, which are unsupported.');items.push({type:'text',text:operands[0].value,position:[...textPos],fontSize});textShownSincePositioning=true;}
    else if(op==='q'||op==='Q'||op==='cm'||op==='W'||op==='W*'||op==='Do'||op==='gs'||op==='sh'||op==='BI'||op==='ID'||op==='EI'||op==='TJ'||op==='T*'||op==='\''||op==='"') fail('UNSUPPORTED_PDF',`PDF operator ${op} is unsupported.`);
    else if(['w','J','j','M','G','g','RG','rg','K','k','d'].includes(op)) fail('UNSUPPORTED_PDF',`PDF graphics style operator ${op} is unsupported.`);
    else fail('UNSUPPORTED_PDF',`PDF content operator ${op} is unsupported.`);
    operands.length=0;
  }
  if(operands.length||textMode)fail('INVALID_PDF','Dangling operands or unclosed text block.');
  flush(); return items;
}

function serializeItems(items) {
  if(!Array.isArray(items)) fail('INVALID_DOCUMENT','Page items must be an array.');
  const lines=[];
  for(const item of items){
    if(item.type==='path'){
      if(!Array.isArray(item.segments)||!item.segments.length)fail('INVALID_DOCUMENT','Path has no segments.');
      for(const s of item.segments){if(s.op==='Z'){lines.push('h');continue;}const points=s.points;if(s.op==='M'||s.op==='L'){if(points?.length!==1||points[0].length!==2)fail('INVALID_DOCUMENT','Malformed path point.');lines.push(`${num(points[0][0])} ${num(points[0][1])} ${s.op==='M'?'m':'l'}`);}else if(s.op==='C'){if(points?.length!==3||points.some(p=>p.length!==2))fail('INVALID_DOCUMENT','Malformed cubic path.');lines.push(`${points.flat().map(num).join(' ')} c`);}else fail('INVALID_DOCUMENT','Unsupported path segment.');}
      const paints = { S:'S', s:'s', f:'f', F:'f', 'f*':'f*', B:'B', 'B*':'B*', b:'b', 'b*':'b*' };
      lines.push(paints[item.paint] || 'S');
    } else if(item.type==='text') {
      if(typeof item.text!=='string'||!/^[\x20-\x7e]*$/.test(item.text)||!Array.isArray(item.position)||item.position.length!==2)fail('INVALID_DOCUMENT','Text must be printable ASCII with a valid position.');
      if(!Number.isFinite(item.fontSize)||item.fontSize<=0)fail('INVALID_DOCUMENT','Text font size must be positive and finite.');
      lines.push(`BT /F1 ${num(item.fontSize)} Tf 1 0 0 1 ${num(item.position[0])} ${num(item.position[1])} Tm (${item.text.replace(/[()\\]/g,'\\$&')}) Tj ET`);
    } else fail('INVALID_DOCUMENT','Unsupported page item.');
  }
  return lines.join('\n');
}
