// dict_to_json.js (完全確定版)
function dictionary(dictName) {
    var d = new Dict(dictName);
    var compactStr = d.stringify().replace(/\s+/g, ""); // 全ての空白・改行を完全に抹殺して1つの強固なシンボルにする
    outlet(0, "clip_data", compactStr);
}