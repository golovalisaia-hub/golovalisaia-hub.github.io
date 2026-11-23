import {openFieldBytes,sealFieldBytes,verifyFieldKey} from './field-security.js';

const blockSize = 1024 * 1024;
const nonceSize = 12;
const overhead = nonceSize + 16;
const binding = (chunk,index) => ['offline-map-v1',chunk.path,chunk.sha256,index];

export const sealedSize = bytes => bytes + Math.ceil(bytes / blockSize) * overhead;

export function createArchiveProtection(unlockKey) {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const blocks = new Map();
  let key = unlockKey;
  let verification;

  async function verify() {
    signal.throwIfAborted();
    verification ??= verifyFieldKey(key);
    await verification;
    signal.throwIfAborted();
  }

  async function seal(chunk,bytes) {
    const encrypted = [];
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      signal.throwIfAborted();
      const {iv,ciphertext} = await sealFieldBytes(key,binding(chunk,offset / blockSize),
        bytes.subarray(offset,offset + blockSize));
      encrypted.push(iv,ciphertext);
    }
    signal.throwIfAborted();
    return new Blob(encrypted,{type:'application/octet-stream'});
  }

  async function decrypt(blob,chunk,index) {
    const start = index * (blockSize + overhead);
    const bytes = new Uint8Array(await blob.slice(start,start + blockSize + overhead).arrayBuffer());
    signal.throwIfAborted();
    return openFieldBytes(key,binding(chunk,index),{
      iv:bytes.subarray(0,nonceSize),ciphertext:bytes.subarray(nonceSize),
    });
  }

  function cachedBlock(blob,chunk,index) {
    const address = chunk.path + ':' + index;
    const hit = blocks.get(address);
    if (hit) {
      blocks.delete(address);
      blocks.set(address,hit);
      return hit;
    }
    const pending = decrypt(blob,chunk,index);
    blocks.set(address,pending);
    if (blocks.size > 8) blocks.delete(blocks.keys().next().value);
    void pending.catch(() => { if (blocks.get(address) === pending) blocks.delete(address); });
    return pending;
  }

  async function read(blob,chunk,offset,length,remember,request) {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      signal.throwIfAborted();
      request?.throwIfAborted();
      const position = offset + written;
      const index = Math.floor(position / blockSize);
      const start = position % blockSize;
      const block = await (remember ? cachedBlock(blob,chunk,index) : decrypt(blob,chunk,index));
      if (block.length !== Math.min(blockSize,chunk.bytes - index * blockSize)) {
        throw new Error('Неверный размер зашифрованной части карты.');
      }
      const piece = block.subarray(start,start + length - written);
      result.set(piece,written);
      written += piece.length;
    }
    signal.throwIfAborted();
    request?.throwIfAborted();
    return result;
  }

  function archive(parts,manifest) {
    function stream() {
      let index = 0;
      return new ReadableStream({
        async pull(controller) {
          if (index === parts.length) {
            controller.close();
            return;
          }
          const chunk = manifest.chunks[index];
          controller.enqueue(await read(parts[index],chunk,0,chunk.bytes,false));
          index += 1;
        },
      });
    }
    return {
      size:manifest.bytes,
      async getBytes(offset,length,request) {
        signal.throwIfAborted();
        request?.throwIfAborted();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
            offset < 0 || offset > manifest.bytes || length < 0) throw new RangeError('Неверный диапазон карты.');
        const output = new Uint8Array(Math.min(length,manifest.bytes - offset));
        let written = 0;
        let before = 0;
        for (let index = 0; index < parts.length && written < output.length; index += 1) {
          const chunk = manifest.chunks[index];
          if (before + chunk.bytes > offset) {
            const local = Math.max(0,offset - before);
            const count = Math.min(chunk.bytes - local,output.length - written);
            output.set(await read(parts[index],chunk,local,count,true,request),written);
            written += count;
          }
          before += chunk.bytes;
        }
        return output.buffer;
      },
      stream,
      toBlob:() => new Response(stream()).blob(),
    };
  }

  return {
    archive,seal,signal,verify,
    readPart:(blob,chunk) => read(blob,chunk,0,chunk.bytes,false),
    close() { lifetime.abort(); blocks.clear(); key = undefined; },
  };
}
