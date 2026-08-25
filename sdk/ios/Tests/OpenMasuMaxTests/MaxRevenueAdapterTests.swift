import XCTest
@testable import OpenMasuMax

final class MaxRevenueAdapterTests: XCTestCase {
  func testM4A29MapsHalfEvenMicrosAndPrecision() throws {
    let mapper = MaxRevenueMapper(
      installationId: { "installation:synthetic" },
      impressionId: { "impression:synthetic" }
    )
    let payload = try XCTUnwrap(mapper.map(MaxRevenueObservation(
      revenue: 0.0000015,
      precision: "exact",
      networkName: "Synthetic Network",
      adUnitId: "ad-unit:synthetic",
      format: "rewarded",
      placement: "completion"
    )))
    XCTAssertEqual(payload["amount_unscaled"] as? String, "2")
    XCTAssertEqual(payload["revenue_precision"] as? String, "exact")
    XCTAssertEqual(payload["currency"] as? String, "USD")
  }

  func testM4A29DropsInvalidRevenueAndCountsIt() throws {
    let mapper = MaxRevenueMapper(installationId: { "installation:synthetic" })
    XCTAssertNil(try mapper.map(MaxRevenueObservation(
      revenue: -1,
      precision: "undefined",
      networkName: "Synthetic Network",
      adUnitId: "ad-unit:synthetic",
      format: "banner"
    )))
    XCTAssertEqual(mapper.errorCount, 1)
  }

  func testM4A29DefaultImpressionIdentifierIsUuidV7() throws {
    let mapper = MaxRevenueMapper(installationId: { "installation:synthetic" })
    let payload = try XCTUnwrap(mapper.map(MaxRevenueObservation(
      revenue: 0,
      precision: "undefined",
      networkName: "Synthetic Network",
      adUnitId: "ad-unit:synthetic",
      format: "banner"
    )))
    let value = try XCTUnwrap(payload["impression_id"] as? String)
    let uuid = try XCTUnwrap(UUID(uuidString: String(value.dropFirst("impression:".count))))
    XCTAssertEqual(uuid.uuid.6 >> 4, 7)
    XCTAssertEqual(uuid.uuid.8 >> 6, 2)
  }

  func testM4A29MatchesSharedAndroidAndSwiftMappingVectors() throws {
    let url = findRepositoryFile("sdk/max-revenue-mapping-vectors.json")
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    for vector in fixture["vectors"] as! [[String: Any]] {
      let input = vector["input"] as! [String: Any]
      let mapper = MaxRevenueMapper(
        installationId: { vector["installation_id"] as! String },
        impressionId: { vector["impression_id"] as! String }
      )
      let payload = try XCTUnwrap(mapper.map(MaxRevenueObservation(
        revenue: input["revenue"] as! Double,
        precision: input["precision"] as! String,
        networkName: input["network_name"] as! String,
        adUnitId: input["ad_unit_id"] as! String,
        format: input["format"] as! String,
        placement: input["placement"] as? String,
        networkPlacement: input["network_placement"] as? String
      )))
      let expected = vector["expected_payload"] as! [String: Any]
      let actualBytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
      let expectedBytes = try JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys, .withoutEscapingSlashes])
      XCTAssertEqual(actualBytes, expectedBytes)
    }
  }

  private func findRepositoryFile(_ relativePath: String) -> URL {
    var candidate = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while candidate.path != "/" {
      let value = candidate.appendingPathComponent(relativePath)
      if FileManager.default.fileExists(atPath: value.path) { return value }
      candidate.deleteLastPathComponent()
    }
    XCTFail("repository file not found: \(relativePath)")
    return URL(fileURLWithPath: relativePath)
  }
}
