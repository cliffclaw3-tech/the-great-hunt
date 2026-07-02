const assert = require("node:assert/strict");
const { compQualityReason, inferCategoryFromItem } = require("../server");

function reason({ item, title, condition = "Sold", category = "Video games" }) {
  return compQualityReason({
    item,
    category,
    ask: 0,
    result: {
      title,
      condition,
      price: 0,
      shipping: 0,
      total: 50,
      confidence: 86
    }
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test("infers video games", () => {
  assert.equal(inferCategoryFromItem("Super Mario 64 Nintendo 64 complete in box"), "Video games");
});

test("Super Mario 64 N64 accepts same-platform CIB comp", () => {
  assert.equal(
    reason({
      item: "Super Mario 64 Nintendo 64 complete in box",
      title: "Super Mario 64 N64 Nintendo 64 Complete In Box CIB Authentic"
    }),
    ""
  );
});

test("Super Mario 64 N64 rejects DS comp", () => {
  assert.match(
    reason({
      item: "Super Mario 64 Nintendo 64 complete in box",
      title: "Super Mario 64 DS Nintendo DS Complete With Case Manual"
    }),
    /Different video-game platform|extra platform discriminator|Missing query discriminator/
  );
});

test("bare Super Mario 64 routes to research because platform is ambiguous", () => {
  assert.match(
    reason({
      item: "Super Mario 64",
      title: "Super Mario 64 DS Nintendo DS Complete With Case Manual"
    }),
    /platform is ambiguous|extra platform discriminator/
  );
});

test("Super Mario 64 DS accepts DS control comp", () => {
  assert.equal(
    reason({
      item: "Super Mario 64 DS Nintendo DS",
      title: "Super Mario 64 DS Nintendo DS Complete With Case Manual"
    }),
    ""
  );
});

test("right words wrong product cross-platform case is rejected", () => {
  assert.match(
    reason({
      item: "Mario Kart Nintendo 64 complete in box",
      title: "Mario Kart DS Nintendo DS Complete In Box"
    }),
    /Different video-game platform|extra platform discriminator|Missing query discriminator/
  );
});

test("watch accessory strap is rejected as a comp", () => {
  assert.match(
    reason({
      item: "Omega Seamaster watch",
      category: "Watches",
      title: "20mm Mesh Steel Strap For Omega Seamaster Diver 300m Watch Mate"
    }),
    /Likely part or accessory/
  );
});
