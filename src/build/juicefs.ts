import type { BuildExtension } from "@trigger.dev/build/extensions";

/** Install the stock mount-free client in the final task image. No privileges or FUSE required. */
export function juicefsExtension(): BuildExtension {
  return {
    name: "juicefs-client",
    onBuildComplete(context) {
      if (context.target === "dev") return;
      context.addLayer({
        id: "juicefs-1.3.1",
        commands: [
          "curl -fsSL https://github.com/juicedata/juicefs/releases/download/v1.3.1/juicefs-1.3.1-linux-amd64.tar.gz -o /tmp/juicefs.tar.gz",
          "echo 'eb67a7be5d174b420cb3734d441971b3a462ab522b78ad2a6ed993e7deddcd44  /tmp/juicefs.tar.gz' | sha256sum -c -",
          "mkdir -p /app/juicefs-bin && tar -xzf /tmp/juicefs.tar.gz -C /app/juicefs-bin juicefs && chmod 755 /app/juicefs-bin/juicefs && rm /tmp/juicefs.tar.gz",
        ],
      });
    },
  };
}
