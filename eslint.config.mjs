import {defineConfig,globalIgnores} from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
 // Generated artifacts and vendored code are not project source.
 globalIgnores(['.vercel/**','.cloudflare/**','.wrangler/**','.vinext/**','dist/**','output/**','vendor/**']),
 // Only framework routes and React source use Next/React conventions. The
 // standalone public app and Node test VM fixtures are not React components.
 {files:['app/**/*.{js,jsx,ts,tsx}','**/*.{jsx,tsx}'],extends:nextVitals},
 // Preserve actual TypeScript diagnostics for all TS, including business tests.
 {files:['**/*.{ts,tsx}'],extends:nextTypescript},
 // Ordinary browser and Node JS still receive general correctness checks.
 {files:['**/*.{js,mjs,cjs}'],rules:{
  'no-dupe-args':'error','no-dupe-keys':'error','no-unreachable':'error',
  'valid-typeof':'error','no-unsafe-finally':'error','constructor-super':'error',
  'no-unused-vars':['warn',{args:'none',caughtErrors:'none'}],
 }},
]);
