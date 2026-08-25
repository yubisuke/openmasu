import CryptoKit
import Foundation

public enum SdkRequestSigner {
  public static func sha256(_ body: Data) -> String {
    SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
  }

  public static func canonical(
    method: String,
    path: String,
    sdkKeyId: String,
    installationKeyId: String?,
    timestampMs: Int64,
    nonce: String,
    body: Data
  ) -> String {
    [
      "open-mmp-sdk-v1",
      method.uppercased(),
      path,
      sdkKeyId,
      installationKeyId ?? "-",
      String(timestampMs),
      nonce,
      sha256(body),
    ].joined(separator: "\n")
  }

  public static func sign(secret: String, canonical: String) -> String {
    let key = SymmetricKey(data: Data(secret.utf8))
    let code = HMAC<SHA256>.authenticationCode(for: Data(canonical.utf8), using: key)
    return code.map { String(format: "%02x", $0) }.joined()
  }
}
