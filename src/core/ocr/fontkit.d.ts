// `fontkit` ships no type declarations of its own. `devanagariFont.ts` casts
// its way to a small local structural type (`FontkitLike`) immediately after
// import, so this ambient module only needs to stop that one dynamic
// `import('fontkit')` from failing the build with "could not find a
// declaration file" — it is not a stand-in for real fontkit types.
declare module 'fontkit';
