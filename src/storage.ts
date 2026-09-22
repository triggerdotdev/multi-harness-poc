import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ObjectStore {
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, body: Buffer): Promise<void>;
}
function validKey(key: string) {
  if (
    !/^[a-zA-Z0-9/_-]+(?:\.json)?$/.test(key) ||
    key.split("/").some((part) => !part || part === "..")
  )
    throw new Error("Invalid storage key");
  return key;
}
export class FileStore implements ObjectStore {
  constructor(readonly root: string) {}
  async get(key: string) {
    try {
      return await readFile(join(this.root, validKey(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async put(key: string, body: Buffer) {
    const path = join(this.root, validKey(key));
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
  }
}
export class S3Store implements ObjectStore {
  private readonly client: S3Client;
  constructor(
    readonly bucket: string,
    readonly prefix = "multi-harness",
    options: {
      endpoint?: string;
      region?: string;
      forcePathStyle?: boolean;
    } = {},
  ) {
    validKey(prefix);
    this.client = new S3Client({
      region: options.region || "us-east-1",
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 5,
    });
  }
  async get(key: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}/${validKey(key)}`,
        }),
      );
      if (!response.Body)
        throw new Error("Object storage returned an empty body");
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return undefined;
      throw error;
    }
  }
  async put(key: string, body: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}/${validKey(key)}`,
        Body: body,
      }),
    );
  }
}
export function createStore(options: { deployed?: boolean } = {}): ObjectStore {
  if (process.env.STORAGE_BUCKET)
    return new S3Store(
      process.env.STORAGE_BUCKET,
      process.env.STORAGE_PREFIX || "multi-harness",
      {
        endpoint: process.env.STORAGE_ENDPOINT || undefined,
        region: process.env.AWS_REGION,
        forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
      },
    );
  if (options.deployed)
    throw new Error(
      "Deployed workers require STORAGE_BUCKET. Local disk is not durable across cloud workers.",
    );
  if (!process.env.STORAGE_DIR || !isAbsolute(process.env.STORAGE_DIR)) {
    throw new Error(
      "Set STORAGE_DIR to an absolute path shared by the frontend and local worker. pnpm run setup creates this setting.",
    );
  }
  return new FileStore(resolve(process.env.STORAGE_DIR));
}
export const digest = (body: Buffer) =>
  createHash("sha256").update(body).digest("hex");
export async function putJSON(store: ObjectStore, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const key = `objects/${digest(body)}`;
  await store.put(key, body);
  return key;
}
export async function getJSON<T>(store: ObjectStore, key: string): Promise<T> {
  const body = await store.get(key);
  if (!body) throw new Error(`Missing durable object: ${key}`);
  if (key.startsWith("objects/") && digest(body) !== key.slice(8))
    throw new Error("Durable object integrity check failed");
  return JSON.parse(body.toString("utf8")) as T;
}
