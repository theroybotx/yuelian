import {isDeepStrictEqual} from 'node:util';

// Leaf module: CLI entrypoints must never dynamically import one another
// while their top-level release operation is still awaiting completion.
export function checkedCiManifest(built,checked,sha){
 if(built.sourceCommit!==sha||checked.sourceCommit!==sha||!built.files||typeof built.files!=='object'||Array.isArray(built.files)||Object.keys(built.files).length===0||!isDeepStrictEqual(built.files,checked.files))throw Error('Production artifact differs from the same-run checked artifact; upload refused');
}
