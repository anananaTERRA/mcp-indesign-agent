/**
 * MCP InDesign Agent — unique runtime dispatcher (ExtendScript / ES3).
 * Invoked via: do script … with arguments { requestPath, responsePath }
 *
 * Ops: ping | noop | scanDocument | getSelection
 *      moveItem | resizeItem | deleteItem | duplicateItem
 *      setText | replaceText | setFont | setFill
 *      alignItems | distributeItems | centerItems | stackItems | applyMargins
 */
#target "InDesign"

var MCP_LABEL_PREFIX = "mcp:";

function mcpReadFile(path) {
  var f = new File(path);
  if (!f.exists) {
    throw new Error("Request file not found: " + path);
  }
  f.encoding = "UTF-8";
  f.open("r");
  var contents = f.read();
  f.close();
  return contents;
}

function mcpWriteFile(path, contents) {
  var f = new File(path);
  f.encoding = "UTF-8";
  f.open("w");
  f.write(contents);
  f.close();
}

function mcpParseJson(text) {
  if (typeof JSON !== "undefined" && JSON.parse) {
    return JSON.parse(text);
  }
  return eval("(" + text + ")");
}

function mcpStringify(value) {
  if (typeof JSON !== "undefined" && JSON.stringify) {
    return JSON.stringify(value);
  }
  return mcpStringifyFallback(value);
}

function mcpStringifyFallback(value) {
  if (value === null) return "null";
  var t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "string") {
    return (
      '"' +
      value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t") +
      '"'
    );
  }
  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      parts.push(mcpStringifyFallback(value[i]));
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    var keys = [];
    for (var k in value) {
      if (value.hasOwnProperty(k) && typeof value[k] !== "undefined") {
        keys.push(mcpStringifyFallback(k) + ":" + mcpStringifyFallback(value[k]));
      }
    }
    return "{" + keys.join(",") + "}";
  }
  return "null";
}

function mcpSafePreview(text, maxLen) {
  if (!text) return "";
  var s = String(text).replace(/\s+/g, " ");
  if (s.length > maxLen) {
    return s.substring(0, maxLen);
  }
  return s;
}

function mcpUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function mcpStripPrefix(label) {
  if (!label) return null;
  var s = String(label);
  if (s.indexOf(MCP_LABEL_PREFIX) === 0) {
    return s.substring(MCP_LABEL_PREFIX.length);
  }
  return null;
}

/**
 * Ensure page item has mcp:<uuid> script label. Returns uuid without prefix.
 */
function mcpEnsureUuid(item) {
  var existing = "";
  try {
    existing = String(item.label || "");
  } catch (e) {
    existing = "";
  }
  var uuid = mcpStripPrefix(existing);
  if (uuid && uuid.length > 0) {
    return uuid;
  }
  uuid = mcpUuid();
  try {
    item.label = MCP_LABEL_PREFIX + uuid;
  } catch (e2) {
    /* locked / non-writable — still expose ephemeral uuid this scan */
  }
  return uuid;
}

function mcpBounds(item) {
  try {
    var b = item.geometricBounds; // [y1, x1, y2, x2]
    return {
      y1: b[0],
      x1: b[1],
      y2: b[2],
      x2: b[3],
    };
  } catch (e) {
    return null;
  }
}

function mcpItemType(item) {
  try {
    if (item instanceof TextFrame) return "TextFrame";
    if (item instanceof Rectangle) return "Rectangle";
    if (item instanceof Oval) return "Oval";
    if (item instanceof GraphicLine) return "GraphicLine";
    if (item instanceof Polygon) return "Polygon";
    if (item instanceof Group) return "Group";
  } catch (e) {
    /* ignore */
  }
  try {
    return String(item.reflect.name);
  } catch (e2) {
    return "PageItem";
  }
}

function mcpDocPath(d) {
  try {
    if (d.saved) {
      return String(d.fullName.fsName);
    }
  } catch (e) {
    /* unsaved or unavailable */
  }
  return null;
}

function mcpTextPreview(item) {
  try {
    if (item.hasOwnProperty("contents")) {
      return mcpSafePreview(item.contents, 120);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (item.texts && item.texts.length > 0) {
      return mcpSafePreview(item.texts[0].contents, 120);
    }
  } catch (e2) {
    /* ignore */
  }
  return "";
}

function mcpParagraphStyle(item) {
  try {
    if (item instanceof TextFrame && item.paragraphs && item.paragraphs.length > 0) {
      return String(item.paragraphs[0].appliedParagraphStyle.name);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpFontSize(item) {
  try {
    if (item instanceof TextFrame && item.texts && item.texts.length > 0) {
      return Number(item.texts[0].pointSize);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpLayerName(item) {
  try {
    return String(item.itemLayer.name);
  } catch (e) {
    return null;
  }
}

function mcpParentUuid(item, uuidByItem) {
  try {
    var p = item.parent;
    if (p && p instanceof Group) {
      var key = mcpItemKey(p);
      if (uuidByItem[key]) return uuidByItem[key];
      return mcpEnsureUuid(p);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpItemKey(item) {
  try {
    return String(item.id);
  } catch (e) {
    return String(item);
  }
}

function mcpPageIndexForItem(item, doc) {
  try {
    var p = item.parentPage;
    if (p) {
      for (var i = 0; i < doc.pages.length; i++) {
        if (doc.pages[i] === p) return i;
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function mcpCollectStyleNames(collection) {
  var out = [];
  var i;
  try {
    for (i = 0; i < collection.length; i++) {
      try {
        out.push({ name: String(collection[i].name) });
      } catch (e) {
        /* skip */
      }
    }
  } catch (e2) {
    /* ignore */
  }
  return out;
}

function mcpLinkStatus(link) {
  try {
    return String(link.status);
  } catch (e) {
    return "UNKNOWN";
  }
}

function opPing() {
  var doc = null;
  if (app.documents.length > 0) {
    var d = app.activeDocument;
    doc = {
      name: d.name,
      path: mcpDocPath(d),
      pageCount: d.pages.length,
    };
  }
  return {
    op: "ping",
    appName: String(app.name),
    version: String(app.version),
    locale: String(app.locale),
    document: doc,
  };
}

function opNoop(cmd) {
  return {
    op: "noop",
    echo: cmd && cmd.echo !== undefined ? cmd.echo : null,
  };
}

function opScanDocument(cmd) {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }

  var depth = (cmd && cmd.depth) || "full";
  var writeUuids = !(cmd && cmd.writeUuids === false);
  var d = app.activeDocument;
  var pageSize = null;
  try {
    var pb = d.documentPreferences;
    pageSize = {
      width: pb.pageWidth,
      height: pb.pageHeight,
    };
  } catch (e) {
    /* ignore */
  }

  var units = null;
  try {
    units = String(d.viewPreferences.horizontalMeasurementUnits);
  } catch (e2) {
    /* ignore */
  }

  var pages = [];
  var items = [];
  var uuidByItem = {};
  var pageLimit = d.pages.length;
  var i;
  var j;

  for (i = 0; i < pageLimit; i++) {
    var page = d.pages[i];
    pages.push({
      index: i,
      name: String(page.name),
    });

    if (depth === "none") {
      continue;
    }

    var pageItems = page.allPageItems;
    // First pass: ensure UUIDs so parent resolution works.
    for (j = 0; j < pageItems.length; j++) {
      var it0 = pageItems[j];
      var uuid0 = writeUuids ? mcpEnsureUuid(it0) : mcpStripPrefix(String(it0.label || "")) || ("tmp-" + j);
      uuidByItem[mcpItemKey(it0)] = uuid0;
    }

    for (j = 0; j < pageItems.length; j++) {
      var it = pageItems[j];
      var uuid = uuidByItem[mcpItemKey(it)];
      var entry = {
        uuid: uuid,
        pageIndex: i,
        itemIndex: j,
        type: mcpItemType(it),
        bounds: mcpBounds(it),
        label: MCP_LABEL_PREFIX + uuid,
        textPreview: "",
        parentUuid: null,
        layerName: null,
        paragraphStyle: null,
        fontSize: null,
      };
      entry.textPreview = mcpTextPreview(it);
      if (depth === "full" || depth === "rich") {
        entry.parentUuid = mcpParentUuid(it, uuidByItem);
        entry.layerName = mcpLayerName(it);
        entry.paragraphStyle = mcpParagraphStyle(it);
        entry.fontSize = mcpFontSize(it);
      }
      items.push(entry);
    }
  }

  var layers = [];
  var styles = { paragraph: [], character: [], object: [] };
  var swatches = [];
  var fonts = [];
  var links = [];
  var masterPages = [];
  var selection = [];

  if (depth === "full" || depth === "rich") {
    try {
      for (i = 0; i < d.layers.length; i++) {
        var layer = d.layers[i];
        layers.push({
          name: String(layer.name),
          visible: !!layer.visible,
          locked: !!layer.locked,
        });
      }
    } catch (eL) {
      /* ignore */
    }

    try {
      styles.paragraph = mcpCollectStyleNames(d.paragraphStyles);
      styles.character = mcpCollectStyleNames(d.characterStyles);
      styles.object = mcpCollectStyleNames(d.objectStyles);
    } catch (eS) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.swatches.length; i++) {
        try {
          swatches.push({
            name: String(d.swatches[i].name),
            colorType: null,
          });
        } catch (eSw) {
          /* skip */
        }
      }
    } catch (eSw2) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.fonts.length; i++) {
        try {
          fonts.push({
            name: String(d.fonts[i].name),
            status: String(d.fonts[i].status),
          });
        } catch (eF) {
          /* skip */
        }
      }
    } catch (eF2) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.links.length; i++) {
        var link = d.links[i];
        var linkPage = null;
        try {
          if (link.parent && link.parent.parentPage) {
            linkPage = mcpPageIndexForItem(link.parent, d);
          }
        } catch (eLp) {
          /* ignore */
        }
        var filePath = null;
        try {
          filePath = String(link.filePath);
        } catch (eFp) {
          /* ignore */
        }
        links.push({
          id: String(link.id),
          name: String(link.name),
          filePath: filePath,
          status: mcpLinkStatus(link),
          pageIndex: linkPage,
        });
      }
    } catch (eLk) {
      /* ignore */
    }

    try {
      for (i = 0; i < d.masterSpreads.length; i++) {
        var ms = d.masterSpreads[i];
        masterPages.push({
          name: String(ms.name),
          index: i,
        });
      }
    } catch (eM) {
      /* ignore */
    }

    selection = mcpReadSelectionUuids(d, writeUuids);
  }

  var uuidList = [];
  for (i = 0; i < items.length; i++) {
    uuidList.push(items[i].uuid);
  }
  uuidList.sort();
  var generation =
    String(mcpDocPath(d) || "unsaved") +
    "|p" +
    d.pages.length +
    "|n" +
    items.length +
    "|" +
    uuidList.join(",").length;

  return {
    op: "scanDocument",
    depth: depth,
    meta: {
      name: d.name,
      path: mcpDocPath(d),
      pageCount: d.pages.length,
      pageSize: pageSize,
      units: units,
      generation: generation,
    },
    pages: pages,
    items: items,
    layers: layers,
    styles: styles,
    swatches: swatches,
    fonts: fonts,
    links: links,
    masterPages: masterPages,
    selection: selection,
  };
}

function mcpReadSelectionUuids(doc, writeUuids) {
  var out = [];
  var i;
  try {
    var sel = app.selection;
    for (i = 0; i < sel.length; i++) {
      var s = sel[i];
      try {
        // Text selection → resolve to parent text frame when possible
        if (s.hasOwnProperty("parentTextFrames")) {
          var tfs = s.parentTextFrames;
          if (tfs && tfs.length > 0) {
            s = tfs[0];
          }
        }
      } catch (eTf) {
        /* ignore */
      }
      try {
        if (s instanceof PageItem || s instanceof TextFrame || s instanceof Group) {
          var u = writeUuids ? mcpEnsureUuid(s) : mcpStripPrefix(String(s.label || ""));
          if (u) out.push(u);
        }
      } catch (eSel) {
        /* skip non-page-items */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return out;
}

function opGetSelection(cmd) {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }
  var writeUuids = !(cmd && cmd.writeUuids === false);
  var d = app.activeDocument;
  var uuids = mcpReadSelectionUuids(d, writeUuids);
  var items = [];
  var i;
  var sel = app.selection;
  for (i = 0; i < sel.length; i++) {
    var s = sel[i];
    try {
      if (s.hasOwnProperty("parentTextFrames")) {
        var tfs = s.parentTextFrames;
        if (tfs && tfs.length > 0) s = tfs[0];
      }
    } catch (e1) {
      /* ignore */
    }
    try {
      if (!(s instanceof PageItem || s instanceof TextFrame || s instanceof Group)) {
        continue;
      }
      var uuid = writeUuids ? mcpEnsureUuid(s) : mcpStripPrefix(String(s.label || ""));
      if (!uuid) continue;
      items.push({
        uuid: uuid,
        pageIndex: mcpPageIndexForItem(s, d),
        type: mcpItemType(s),
        bounds: mcpBounds(s),
        textPreview: mcpTextPreview(s),
      });
    } catch (e2) {
      /* skip */
    }
  }
  return {
    op: "getSelection",
    selection: uuids,
    items: items,
  };
}

/* ─── Mutations (phase 3) — coordinates in POINTS ─── */

var gModelPatch = { updated: [], removed: [] };

function mcpRequireDoc() {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }
  return app.activeDocument;
}

function mcpFindByUuid(doc, uuid) {
  var label = MCP_LABEL_PREFIX + String(uuid);
  var i;
  var j;
  for (i = 0; i < doc.pages.length; i++) {
    var pageItems = doc.pages[i].allPageItems;
    for (j = 0; j < pageItems.length; j++) {
      try {
        if (String(pageItems[j].label || "") === label) {
          return pageItems[j];
        }
      } catch (e) {
        /* skip */
      }
    }
  }
  throw new Error("ITEM_NOT_FOUND: No page item with uuid " + uuid);
}

function mcpSerializeItem(item, doc) {
  var uuid = mcpEnsureUuid(item);
  return {
    uuid: uuid,
    pageIndex: mcpPageIndexForItem(item, doc),
    itemIndex: 0,
    type: mcpItemType(item),
    bounds: mcpBounds(item),
    textPreview: mcpTextPreview(item),
    parentUuid: null,
    layerName: mcpLayerName(item),
    paragraphStyle: mcpParagraphStyle(item),
    fontSize: mcpFontSize(item),
  };
}

function mcpPatchUpdated(item, doc) {
  gModelPatch.updated.push(mcpSerializeItem(item, doc));
}

function mcpPatchRemoved(uuid) {
  gModelPatch.removed.push(String(uuid));
}

function mcpSetBounds(item, y1, x1, y2, x2) {
  item.geometricBounds = [y1, x1, y2, x2];
}

function opMoveItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var b = item.geometricBounds;
  var y1 = b[0];
  var x1 = b[1];
  var y2 = b[2];
  var x2 = b[3];
  var w = x2 - x1;
  var h = y2 - y1;

  if (cmd.x !== undefined && cmd.x !== null) {
    x1 = Number(cmd.x);
    x2 = x1 + w;
  } else if (cmd.dx !== undefined && cmd.dx !== null) {
    x1 += Number(cmd.dx);
    x2 += Number(cmd.dx);
  }
  if (cmd.y !== undefined && cmd.y !== null) {
    y1 = Number(cmd.y);
    y2 = y1 + h;
  } else if (cmd.dy !== undefined && cmd.dy !== null) {
    y1 += Number(cmd.dy);
    y2 += Number(cmd.dy);
  }

  mcpSetBounds(item, y1, x1, y2, x2);
  mcpPatchUpdated(item, doc);
  return { op: "moveItem", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opResizeItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var b = item.geometricBounds;
  var y1 = b[0];
  var x1 = b[1];
  var y2 = b[2];
  var x2 = b[3];
  var w = x2 - x1;
  var h = y2 - y1;
  if (cmd.width !== undefined && cmd.width !== null) w = Number(cmd.width);
  if (cmd.height !== undefined && cmd.height !== null) h = Number(cmd.height);
  mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
  mcpPatchUpdated(item, doc);
  return { op: "resizeItem", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opDeleteItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  item.remove();
  mcpPatchRemoved(cmd.target);
  return { op: "deleteItem", target: cmd.target, removed: String(cmd.target) };
}

function opDuplicateItem(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var dup = item.duplicate();
  var uuid = mcpUuid();
  try {
    dup.label = MCP_LABEL_PREFIX + uuid;
  } catch (e) {
    /* ignore */
  }
  var dx = cmd.dx !== undefined && cmd.dx !== null ? Number(cmd.dx) : 12;
  var dy = cmd.dy !== undefined && cmd.dy !== null ? Number(cmd.dy) : 12;
  var b = dup.geometricBounds;
  mcpSetBounds(dup, b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx);
  mcpPatchUpdated(dup, doc);
  return {
    op: "duplicateItem",
    target: cmd.target,
    created: mcpSerializeItem(dup, doc),
  };
}

function opSetText(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  try {
    if (item instanceof TextFrame) {
      item.contents = String(cmd.text);
    } else if (item.texts && item.texts.length > 0) {
      item.texts[0].contents = String(cmd.text);
    } else {
      throw new Error("Item is not a text frame");
    }
  } catch (e) {
    throw new Error("setText failed: " + (e.message || e));
  }
  mcpPatchUpdated(item, doc);
  return { op: "setText", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opReplaceText(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var find = String(cmd.find);
  var replace = String(cmd.replace);
  var matchCase = !!cmd.matchCase;
  var contents = "";
  try {
    if (item instanceof TextFrame) contents = String(item.contents);
    else if (item.texts && item.texts.length > 0) contents = String(item.texts[0].contents);
    else throw new Error("Item is not a text frame");
  } catch (e) {
    throw new Error("replaceText read failed: " + (e.message || e));
  }

  var next;
  if (matchCase) {
    next = contents.split(find).join(replace);
  } else {
    var re = new RegExp(find.replace(/([.*+?^${}()|[\]\\])/g, "\\$1"), "gi");
    next = contents.replace(re, replace);
  }

  try {
    if (item instanceof TextFrame) item.contents = next;
    else item.texts[0].contents = next;
  } catch (e2) {
    throw new Error("replaceText write failed: " + (e2.message || e2));
  }
  mcpPatchUpdated(item, doc);
  return { op: "replaceText", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function opSetFont(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var text;
  try {
    if (item instanceof TextFrame && item.texts.length > 0) text = item.texts[0];
    else if (item.texts && item.texts.length > 0) text = item.texts[0];
    else throw new Error("Item has no text");
  } catch (e) {
    throw new Error("setFont: " + (e.message || e));
  }

  if (cmd.fontFamily) {
    try {
      if (cmd.fontStyle) {
        text.appliedFont = String(cmd.fontFamily) + "\t" + String(cmd.fontStyle);
      } else {
        text.appliedFont = String(cmd.fontFamily);
      }
    } catch (eF) {
      throw new Error("setFont fontFamily failed: " + (eF.message || eF));
    }
  }
  if (cmd.fontSizePt !== undefined && cmd.fontSizePt !== null) {
    text.pointSize = Number(cmd.fontSizePt);
  }
  mcpPatchUpdated(item, doc);
  return { op: "setFont", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function mcpResolveFill(doc, fill) {
  if (!fill) throw new Error("setFill requires fill");
  if (fill.swatch) {
    try {
      return doc.swatches.itemByName(String(fill.swatch));
    } catch (e) {
      throw new Error("Swatch not found: " + fill.swatch);
    }
  }
  var name;
  var color;
  if (fill.rgb) {
    name = "mcp-rgb-" + fill.rgb[0] + "-" + fill.rgb[1] + "-" + fill.rgb[2];
    try {
      color = doc.colors.itemByName(name);
      if (!color.isValid) throw new Error("missing");
      return color;
    } catch (e2) {
      color = doc.colors.add({
        name: name,
        model: ColorModel.PROCESS,
        space: ColorSpace.RGB,
        colorValue: [Number(fill.rgb[0]), Number(fill.rgb[1]), Number(fill.rgb[2])],
      });
      return color;
    }
  }
  if (fill.cmyk) {
    name =
      "mcp-cmyk-" +
      fill.cmyk[0] +
      "-" +
      fill.cmyk[1] +
      "-" +
      fill.cmyk[2] +
      "-" +
      fill.cmyk[3];
    try {
      color = doc.colors.itemByName(name);
      if (!color.isValid) throw new Error("missing");
      return color;
    } catch (e3) {
      color = doc.colors.add({
        name: name,
        model: ColorModel.PROCESS,
        space: ColorSpace.CMYK,
        colorValue: [
          Number(fill.cmyk[0]),
          Number(fill.cmyk[1]),
          Number(fill.cmyk[2]),
          Number(fill.cmyk[3]),
        ],
      });
      return color;
    }
  }
  throw new Error("Unsupported fill spec");
}

function opSetFill(cmd) {
  var doc = mcpRequireDoc();
  var item = mcpFindByUuid(doc, cmd.target);
  var color = mcpResolveFill(doc, cmd.fill);
  try {
    item.fillColor = color;
  } catch (e) {
    throw new Error("setFill failed: " + (e.message || e));
  }
  mcpPatchUpdated(item, doc);
  return { op: "setFill", target: cmd.target, item: mcpSerializeItem(item, doc) };
}

function mcpCollectTargets(doc, targets) {
  var items = [];
  var i;
  for (i = 0; i < targets.length; i++) {
    items.push(mcpFindByUuid(doc, targets[i]));
  }
  return items;
}

function mcpPageSizePts(doc) {
  return {
    width: Number(doc.documentPreferences.pageWidth),
    height: Number(doc.documentPreferences.pageHeight),
  };
}

function opAlignItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var page = mcpPageSizePts(doc);
  var align = String(cmd.align || "left");
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var item = items[i];
    var b = item.geometricBounds;
    var y1 = b[0];
    var x1 = b[1];
    var y2 = b[2];
    var x2 = b[3];
    var w = x2 - x1;
    var h = y2 - y1;
    if (align === "left") x1 = 0;
    else if (align === "center") x1 = (page.width - w) / 2;
    else if (align === "right") x1 = page.width - w;
    else if (align === "top") y1 = 0;
    else if (align === "middle") y1 = (page.height - h) / 2;
    else if (align === "bottom") y1 = page.height - h;
    mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
    mcpPatchUpdated(item, doc);
    out.push(mcpSerializeItem(item, doc));
  }
  return { op: "alignItems", align: align, items: out };
}

function opDistributeItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  if (items.length < 2) {
    return { op: "distributeItems", items: [], note: "need ≥2 items" };
  }
  var axis = String(cmd.axis || "vertical");
  var entries = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var b = items[i].geometricBounds;
    entries.push({
      item: items[i],
      y1: b[0],
      x1: b[1],
      y2: b[2],
      x2: b[3],
      w: b[3] - b[1],
      h: b[2] - b[0],
    });
  }
  entries.sort(function (a, c) {
    return axis === "horizontal" ? a.x1 - c.x1 : a.y1 - c.y1;
  });

  var first = entries[0];
  var last = entries[entries.length - 1];
  var totalSize = 0;
  for (i = 0; i < entries.length; i++) {
    totalSize += axis === "horizontal" ? entries[i].w : entries[i].h;
  }
  var span =
    axis === "horizontal"
      ? last.x1 + last.w - first.x1 - totalSize
      : last.y1 + last.h - first.y1 - totalSize;
  var gap = span / (entries.length - 1);
  var cursor = axis === "horizontal" ? first.x1 : first.y1;
  var out = [];

  for (i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (axis === "horizontal") {
      mcpSetBounds(e.item, e.y1, cursor, e.y1 + e.h, cursor + e.w);
      cursor += e.w + gap;
    } else {
      mcpSetBounds(e.item, cursor, e.x1, cursor + e.h, e.x1 + e.w);
      cursor += e.h + gap;
    }
    mcpPatchUpdated(e.item, doc);
    out.push(mcpSerializeItem(e.item, doc));
  }
  return { op: "distributeItems", axis: axis, items: out };
}

function opCenterItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var page = mcpPageSizePts(doc);
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var item = items[i];
    var b = item.geometricBounds;
    var w = b[3] - b[1];
    var h = b[2] - b[0];
    var x1 = (page.width - w) / 2;
    var y1 = (page.height - h) / 2;
    mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
    mcpPatchUpdated(item, doc);
    out.push(mcpSerializeItem(item, doc));
  }
  return { op: "centerItems", items: out };
}

function opStackItems(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var axis = String(cmd.axis || "vertical");
  var gap = cmd.gapPt !== undefined && cmd.gapPt !== null ? Number(cmd.gapPt) : 16;
  var entries = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var b = items[i].geometricBounds;
    entries.push({
      item: items[i],
      y1: b[0],
      x1: b[1],
      w: b[3] - b[1],
      h: b[2] - b[0],
    });
  }
  entries.sort(function (a, c) {
    return axis === "horizontal" ? a.x1 - c.x1 : a.y1 - c.y1;
  });
  var cursor =
    cmd.startPt !== undefined && cmd.startPt !== null
      ? Number(cmd.startPt)
      : axis === "horizontal"
        ? entries[0].x1
        : entries[0].y1;
  var out = [];
  for (i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (axis === "horizontal") {
      mcpSetBounds(e.item, e.y1, cursor, e.y1 + e.h, cursor + e.w);
      cursor += e.w + gap;
    } else {
      mcpSetBounds(e.item, cursor, e.x1, cursor + e.h, e.x1 + e.w);
      cursor += e.h + gap;
    }
    mcpPatchUpdated(e.item, doc);
    out.push(mcpSerializeItem(e.item, doc));
  }
  return { op: "stackItems", axis: axis, gapPt: gap, items: out };
}

function opApplyMargins(cmd) {
  var doc = mcpRequireDoc();
  var items = mcpCollectTargets(doc, cmd.targets || []);
  var page = mcpPageSizePts(doc);
  var margin = cmd.marginPt !== undefined && cmd.marginPt !== null ? Number(cmd.marginPt) : 24;
  var out = [];
  var i;
  for (i = 0; i < items.length; i++) {
    var item = items[i];
    var b = item.geometricBounds;
    var w = b[3] - b[1];
    var h = b[2] - b[0];
    var maxW = Math.max(1, page.width - 2 * margin);
    var maxH = Math.max(1, page.height - 2 * margin);
    if (w > maxW) w = maxW;
    if (h > maxH) h = maxH;
    var x1 = b[1];
    var y1 = b[0];
    if (x1 < margin) x1 = margin;
    if (y1 < margin) y1 = margin;
    if (x1 + w > page.width - margin) x1 = page.width - margin - w;
    if (y1 + h > page.height - margin) y1 = page.height - margin - h;
    mcpSetBounds(item, y1, x1, y1 + h, x1 + w);
    mcpPatchUpdated(item, doc);
    out.push(mcpSerializeItem(item, doc));
  }
  return { op: "applyMargins", marginPt: margin, items: out };
}

function runCommand(cmd) {
  if (!cmd || !cmd.op) {
    throw new Error("Command missing op");
  }
  switch (String(cmd.op)) {
    case "ping":
      return opPing();
    case "noop":
      return opNoop(cmd);
    case "scanDocument":
      return opScanDocument(cmd);
    case "getSelection":
      return opGetSelection(cmd);
    case "moveItem":
      return opMoveItem(cmd);
    case "resizeItem":
      return opResizeItem(cmd);
    case "deleteItem":
      return opDeleteItem(cmd);
    case "duplicateItem":
      return opDuplicateItem(cmd);
    case "setText":
      return opSetText(cmd);
    case "replaceText":
      return opReplaceText(cmd);
    case "setFont":
      return opSetFont(cmd);
    case "setFill":
      return opSetFill(cmd);
    case "alignItems":
      return opAlignItems(cmd);
    case "distributeItems":
      return opDistributeItems(cmd);
    case "centerItems":
      return opCenterItems(cmd);
    case "stackItems":
      return opStackItems(cmd);
    case "applyMargins":
      return opApplyMargins(cmd);
    default:
      throw new Error("Unknown op: " + cmd.op);
  }
}

function mcpNeedsPoints(commands) {
  // Keep Document Model + mutations in the same unit (points).
  if (app.documents.length === 0) return false;
  var i;
  for (i = 0; i < commands.length; i++) {
    if (!commands[i] || !commands[i].op) continue;
    var op = String(commands[i].op);
    if (op === "ping" || op === "noop") continue;
    return true;
  }
  return false;
}

function mcpMain() {
  var requestPath = arguments[0];
  var responsePath = arguments[1];
  var result;

  try {
    if (!requestPath || !responsePath) {
      throw new Error("dispatcher requires requestPath and responsePath arguments");
    }

    var payload = mcpParseJson(mcpReadFile(requestPath));
    var commands = payload.commands || [];
    var results = [];
    var c;

    gModelPatch = { updated: [], removed: [] };

    var prevInteraction = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel =
      UserInteractionLevels.NEVER_INTERACT;

    var prevH = null;
    var prevV = null;
    var switchedUnits = false;
    if (app.documents.length > 0 && mcpNeedsPoints(commands)) {
      try {
        prevH = app.activeDocument.viewPreferences.horizontalMeasurementUnits;
        prevV = app.activeDocument.viewPreferences.verticalMeasurementUnits;
        app.activeDocument.viewPreferences.horizontalMeasurementUnits =
          MeasurementUnits.POINTS;
        app.activeDocument.viewPreferences.verticalMeasurementUnits =
          MeasurementUnits.POINTS;
        switchedUnits = true;
      } catch (eU) {
        switchedUnits = false;
      }
    }

    try {
      for (c = 0; c < commands.length; c++) {
        results.push(runCommand(commands[c]));
      }
    } finally {
      if (switchedUnits) {
        try {
          app.activeDocument.viewPreferences.horizontalMeasurementUnits = prevH;
          app.activeDocument.viewPreferences.verticalMeasurementUnits = prevV;
        } catch (eR) {
          /* ignore */
        }
      }
      app.scriptPreferences.userInteractionLevel = prevInteraction;
    }

    var patch = null;
    if (gModelPatch.updated.length > 0 || gModelPatch.removed.length > 0) {
      patch = gModelPatch;
    }

    result = {
      ok: true,
      requestId: payload.requestId || null,
      results: results,
      modelPatch: patch,
    };
  } catch (err) {
    var message = err && err.message ? String(err.message) : String(err);
    result = {
      ok: false,
      requestId: null,
      error: {
        message: message,
        name: err && err.name ? String(err.name) : "Error",
      },
      results: [],
      modelPatch: null,
    };
  }

  try {
    mcpWriteFile(responsePath, mcpStringify(result));
  } catch (writeErr) {
    throw writeErr;
  }
}

mcpMain(arguments[0], arguments[1]);
