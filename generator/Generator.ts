import { readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getGData, RawData } from "./getGData";
import { groupBy } from "./helpers/groupBy";
import { ensureDirectory } from "./helpers/ensureDirectory";
import { analyseAll } from "./analysis";
import prettier from "prettier";
import { generateTypes } from "./generateTs";
import { capitalize } from "./helpers/capitalize";

const prettierOptions = { parser: "typescript" };

export interface GeneratorConfig {
  /** true if the config is disabled */
  disabled?: boolean;

  /** Overrides the generated type for specific fields. */
  overrides: Record<string, string>;

  /** Extracts all values of the key into a type union named as the value. */
  extractedTypes: Record<string, string>;

  /** Extracts all values of the key into a type union named as the value. */
  description: Record<string, string>;

  /** Mapping to override the generated category names. */
  nameOverride: Record<string, string>;

  /** The key in G that this config is used for. Should match the config file name. */
  GKey: string;

  /** The key that should be used to group elements before analysing them. null disables grouping. */
  groupKey: string | null;
}

export class Generator {
  configMap = new Map<string, GeneratorConfig>();
  targetDir: string;
  private configDir?: string;

  constructor(targetDir: string) {
    ensureDirectory(targetDir);
    this.targetDir = targetDir;
  }

  loadConfig(configDir: string) {
    this.configDir = configDir;
    const configFiles = readdirSync(configDir).filter((file) => path.extname(file) === ".json");

    for (const configFile of configFiles) {
      const config = JSON.parse(
        readFileSync(path.join(configDir, configFile), "utf-8")
      ) as GeneratorConfig;

      this.configMap.set(path.basename(configFile, ".json"), config);
    }
  }

  generateDefaultConfigs(data: RawData) {
    generateDefaultConfig: for (const GKey of Object.keys(data)) {
      if (GKey === "version") continue;

      for (const config of this.configMap.values()) {
        if (config.GKey === GKey) {
          console.log();
          continue generateDefaultConfig;
        }
      }

      if (this.configDir) {
        const defaultConfig: GeneratorConfig = {
          disabled: true,
          GKey: GKey,
          groupKey: null,
          nameOverride: {},
          overrides: {},
          extractedTypes: {},
          description: {},
        };

        writeFileSync(
          path.join(this.configDir, `${GKey}.json`),
          JSON.stringify(defaultConfig, null, 2)
        );
      }
    }
  }

  async generate() {
    const data = await getGData();
    const tmpDir = path.resolve(__dirname, "..", "tmp");

    // generate disabled config files for each missing G key
    this.generateDefaultConfigs(data);

    const gTypesIndex: string[] = [];
    const gDataType: string[] = ["\nexport type GData = {"];

    for (const config of this.configMap.values()) {
      const { groupKey, GKey, disabled } = config;

      if (disabled) continue;

      const outDir = path.join(this.targetDir, "GTypes", GKey);

      const grouped = groupKey ? groupBy(data[GKey], groupKey) : { [GKey]: data[GKey] };
      const analysis = analyseAll(grouped, config);

      ensureDirectory(outDir);
      ensureDirectory(path.join(tmpDir, GKey));

      writeFileSync(path.join(tmpDir, GKey, "grouped.json"), JSON.stringify(grouped, null, 2));

      for (const val of analysis) {
        writeFileSync(
          path.join(tmpDir, `${GKey}/${val.category}_analysis.json`),
          JSON.stringify(val, null, 2)
        );

        writeFileSync(
          path.join(outDir, `${val.category}.ts`),
          prettier.format(generateTypes(val, groupKey, config), prettierOptions)
        );
      }

      // Generate index.ts exporting everything inside the category
      const index = analysis.map((val) => `export * from './${val.category}';`);

      if (groupKey) {
        // Add empty line
        index.push("");

        // Import all keys to generate union
        index.push(
          ...analysis.map(
            (val) =>
              `import type { ${val.category}Key, G${val.category} } from './${val.category}';`
          )
        );

        // import GTypes for GTypes/index.ts
        gTypesIndex.push(
          `import type { `,
          `${capitalize(GKey)}Key,`,
          analysis.map((val) => `G${val.category}`).join(","),
          `} from './${GKey}';`
        );

        // Generate union type for all categories
        index.push(`\nexport type ${capitalize(GKey)}Key =`);
        index.push(...analysis.map((val) => `| ${val.category}Key`));
        index.push(`;`);

        // Generate GData interface
        gDataType.push(`${GKey}: {[T in ${capitalize(GKey)}Key]: `);
        // TODO: we need a union type we can use instead.
        gDataType.push(...analysis.map((val) => `| G${capitalize(val.category)}`));
        gDataType.push(`};`);
      } else {
        // Import GDefinition
        const gKeyType = `G${capitalize(GKey)}`;
        gTypesIndex.push(
          `import type { ${capitalize(GKey)}Key, ${gKeyType} } from './${GKey}';`
        );

        gDataType.push(`${GKey}: {[T in ${capitalize(GKey)}Key]: ${gKeyType}};`);
      }

      writeFileSync(
        path.join(outDir, "index.ts"),
        prettier.format(index.join("\n") + ";", prettierOptions)
      );
    }

    // Generate index.ts for GTypes
    const gTypesDir = path.join(this.targetDir, "GTypes");

    // End the gDataType definition
    gDataType.push("}");

    gTypesIndex.push(gDataType.join("\n"));

    writeFileSync(
      path.join(gTypesDir, "index.ts"),
      prettier.format(`${gTypesIndex.join("\n")}`, prettierOptions)
    );
  }
}
