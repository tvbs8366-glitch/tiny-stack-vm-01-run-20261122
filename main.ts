// Tiny stack VM for make.fun's tiny-stack-vm-01 (ISA v1).
// Reads /input/<id>/program.bin + input.bin for every id, runs the program,
// and writes /output/<id>/stdout.bin + exit.txt for each one.
// Run locally: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Opcode table: [opcode, immediate bytes, pops, pushes], packed as
// ((imm << 4) | (pops << 2) | pushes) + 1, so 0 means "not an opcode".
const TAB = new Uint8Array(256);
for (const [o, m, p, q] of [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
]) TAB[o] = ((m << 4) | (p << 2) | q) + 1;

// Runs one program on its input. Returns [bytes written, exit code].
function run(prog: Buffer, inp: Buffer): [Uint8Array, number] {
  const n = prog.length;
  const S = new Int32Array(256); // data stack
  const M = new Int32Array(256); // memory, 256 words
  const C = new Int32Array(64); // call stack
  const O = new Uint8Array(65536); // output
  let sp = 0, cp = 0, ip = 0, pc = 0, steps = 0, ol = 0;
  const end = (code: number): [Uint8Array, number] => [O.subarray(0, ol), code];
  for (;;) {
    if (steps === 1000000) return end(10); // step limit
    if (pc < 0 || pc >= n) return end(9); // pc outside the program
    const op = prog[pc];
    const t = TAB[op];
    if (!t) return end(5); // unknown opcode
    const v = t - 1, im = v >> 4, po = (v >> 2) & 3, pu = v & 3;
    if (pc + im >= n) return end(9); // immediate cut off by the end
    steps++;
    const nx = pc + 1 + im;
    if (sp < po) return end(2); // stack underflow
    if (sp - po + pu > 256) return end(3); // stack overflow
    pc = nx;
    switch (op) {
      case 0x00: return end(0); // HALT
      case 0x01: S[sp++] = (prog[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian
        S[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: S[sp] = S[sp - 1]; sp++; break; // DUP
      case 0x05: { const a = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = a; break; } // SWAP
      case 0x06: S[sp] = S[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a; break; } // ROT
      case 0x17: S[sp - 1] = (-S[sp - 1]) | 0; break; // NEG (wraps)
      case 0x1b: S[sp - 1] = ~S[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = S[sp - 1], a = S[sp - 2];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0; // ADD
        else if (op === 0x11) r = (a - b) | 0; // SUB
        else if (op === 0x12) r = Math.imul(a, b); // MUL, low 32 bits
        else if (op === 0x13) { // DIV, truncated toward zero
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) { // MOD, sign of a
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) { // DIVU
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) { // MODU
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b; // AND
        else if (op === 0x19) r = a | b; // OR
        else if (op === 0x1a) r = a ^ b; // XOR
        else if (op === 0x1c) r = a << (b & 31); // SHL
        else if (op === 0x1d) r = a >> (b & 31); // SHR, arithmetic
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // SHRU, logical
        else if (op === 0x20) r = a === b ? 1 : 0; // EQ
        else if (op === 0x21) r = a < b ? 1 : 0; // LT, signed
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU, unsigned
        S[sp - 2] = r; sp--;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (op !== 0x30) { const w = S[--sp]; take = op === 0x31 ? w === 0 : w !== 0; }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return end(7);
        C[cp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return end(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = S[sp - 1];
        if (a < 0 || a >= 256) return end(6);
        S[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE ( v addr -- )
        const a = S[sp - 1], w = S[sp - 2];
        if (a < 0 || a >= 256) return end(6);
        M[a] = w; sp -= 2;
        break;
      }
      case 0x50: { // PRINT, decimal, no newline
        const s = String(S[sp - 1]);
        if (ol + s.length > 65536) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) O[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC, one byte
        if (ol + 1 > 65536) return end(11);
        O[ol++] = S[--sp] & 255;
        break;
      case 0x52: S[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN, -1 when used up
      case 0x53: return end(S[--sp] & 255); // EXIT, low byte
    }
  }
}

for (const id of readdirSync(IN).sort()) {
  if (!statSync(join(IN, id)).isDirectory()) continue; // skip stray files at /input
  const [o, code] = run(readFileSync(join(IN, id, 'program.bin')), readFileSync(join(IN, id, 'input.bin')));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'stdout.bin'), o);
  writeFileSync(join(OUT, id, 'exit.txt'), String(code) + '\n');
}
