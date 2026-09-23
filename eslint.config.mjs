import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const base = await generateEslintConfig({ enableTypescript: true, ignores: ['dist/**', 'pkg/**', 'test/**'] })

export default [
  ...base,
  {
    // The code keeps its own layout (two spaces, long single-line statements);
    // lint checks correctness, not formatting.
    rules: { 'prettier/prettier': 'off' },
  },
]
