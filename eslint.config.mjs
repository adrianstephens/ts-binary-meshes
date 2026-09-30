import eslint from "@eslint/js";
import tslint from "typescript-eslint";
import { dirname } from 'path';
import { fileURLToPath } from 'url';
async function maybeImport(modulePath) { try { return await import(modulePath); } catch { return undefined; } }
let customPlugin = await maybeImport('../eslint-custom.mjs');
// @ts-check

export default tslint.config(
    eslint.configs.recommended,
    ...tslint.configs.recommended,
    ...tslint.configs.stylistic,
	...(customPlugin ? [customPlugin.config] : []),
    {
        rules: {
                        "semi": ["error", "always"], // Add this line to enforce semicolon use
            "no-empty": "off",
            "@typescript-eslint/no-duplicate-enum-values": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            //"@typescript-eslint/no-misleading-character-class": "off",
            //"@typescript-eslint/no-this-alias": "off",
            "@typescript-eslint/no-unused-vars":  [
                "warn", {
                    argsIgnorePattern: "^(_+$|_[^_])",
                    varsIgnorePattern: "^(_+$|_[^_])",
                },
            ],
            "@typescript-eslint/no-explicit-any": "off",
            //"@typescript-eslint/explicit-module-boundary-types": "off",
            //"@typescript-eslint/no-non-null-assertion": "off"
	        "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/consistent-indexed-object-style": "off",
            "@typescript-eslint/consistent-type-definitions": "off",
        },
    },
    {
        files: ["src/*.ts"],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: dirname(fileURLToPath(import.meta.url))
            }
        }
        
    }
);
