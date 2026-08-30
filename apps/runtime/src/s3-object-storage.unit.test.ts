import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { putS3Object, s3ObjectUrl, signAwsV4Request } from "./s3-object-storage.js";

const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("S3-compatible bulk object storage", () => {
  it("matches the AWS Signature Version 4 official single-chunk GET vector", () => {
    const signed = signAwsV4Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      credentials,
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now: new Date("2013-05-24T00:00:00.000Z"),
      headers: { range: "bytes=0-9" },
    });
    assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("matches the AWS Signature Version 4 official single-chunk PUT vector", () => {
    const signed = signAwsV4Request({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      region: "us-east-1",
      credentials,
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      now: new Date("2013-05-24T00:00:00.000Z"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
    });
    assert.equal(signed.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("builds a path-style object URL without accepting an ambiguous location", () => {
    assert.equal(
      s3ObjectUrl(new URL("https://account.r2.cloudflarestorage.com"), "synthetic-bucket", "openmasu/day=2026-08-30/a b.ndjson.gz").href,
      "https://account.r2.cloudflarestorage.com/synthetic-bucket/openmasu/day%3D2026-08-30/a%20b.ndjson.gz",
    );
    assert.throws(() => s3ObjectUrl(new URL("https://example.test/path"), "bucket", "key"), /location_invalid/);
  });

  describe("conditional delivery", () => {
    let server: ReturnType<typeof createServer>;
    let endpoint = "";
    let putCount = 0;
    let storedDigest = "";
    before(async () => {
      server = createServer((request, response) => {
        if (request.method === "PUT") {
          putCount += 1;
          storedDigest = String(request.headers["x-amz-meta-openmasu-sha256"] ?? "");
          request.resume();
          if (putCount === 1) response.writeHead(200).end();
          else response.writeHead(412).end();
          return;
        }
        response.writeHead(200, { "x-amz-meta-openmasu-sha256": storedDigest }).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("synthetic_server_address_missing");
      endpoint = `http://127.0.0.1:${address.port}`;
    });
    after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    it("stores once and verifies a conditional replay using object digest metadata", async () => {
      const body = Buffer.from("synthetic-gzip-bytes");
      const actualDigest = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
      const common = {
        endpointUrl: endpoint,
        bucket: "synthetic-bucket",
        key: "openmasu/events.ndjson.gz",
        region: "auto",
        credentials,
        body,
        expectedDigest: actualDigest,
        destinationAllowlist: [endpoint],
        allowSyntheticLoopback: true,
        now: new Date("2026-08-30T00:00:00.000Z"),
      } as const;
      assert.deepEqual(await putS3Object(common), { outcome: "stored", httpStatus: 200, digest: actualDigest });
      assert.deepEqual(await putS3Object(common), {
        outcome: "already_present", httpStatus: 200, digest: actualDigest,
      });
      const rejected = await putS3Object({ ...common, expectedDigest: "f".repeat(64) });
      assert.equal(rejected.outcome, "terminal", "the local body digest guard must reject a mismatched caller digest");
    });
  });
});
