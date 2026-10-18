#!/usr/bin/env python3
"""Read-only GameMaker v16 metadata inventory; never exports game assets or dialogue."""

import argparse
import bisect
import hashlib
import json
import struct
from pathlib import Path


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect(path):
    data = path.read_bytes()

    def bounds(offset, size):
        if offset < 0 or size < 0 or offset + size > len(data):
            raise ValueError(f"Out-of-bounds data at {offset:#x}, length {size}")

    def uint(offset):
        bounds(offset, 4)
        return struct.unpack_from("<I", data, offset)[0]

    def string(pointer):
        length = uint(pointer - 4)
        bounds(pointer, length + 1)
        if data[pointer + length] != 0:
            raise ValueError(f"Unterminated string at {pointer:#x}")
        return data[pointer:pointer + length].decode("utf-8", errors="replace")

    if data[:4] != b"FORM" or uint(4) != len(data) - 8:
        raise ValueError("Expected a complete GameMaker FORM container")
    chunks = {}
    offset = 8
    while offset < len(data):
        bounds(offset, 8)
        name = data[offset:offset + 4].decode("ascii")
        size = uint(offset + 4)
        bounds(offset + 8, size)
        if name in chunks:
            raise ValueError(f"Duplicate chunk {name}")
        chunks[name] = {"offset": offset, "size": size}
        offset += size + 8

    def chunk(name):
        return chunks[name]["offset"] + 8

    def pointers(name):
        start = chunk(name)
        count = uint(start)
        if 4 + 4 * count > chunks[name]["size"]:
            raise ValueError(f"Invalid pointer table in {name}")
        result = [uint(start + 4 + 4 * index) for index in range(count)]
        for pointer in result:
            bounds(pointer, 4)
        return result

    gen = chunk("GEN8")
    bounds(gen, 132)
    version = data[gen + 1]
    if version != 16:
        raise ValueError(f"This inspector supports WAD v16, found {version}")
    info = {
        "bytecode_version": version,
        "runtime_version_field": list(struct.unpack_from("<4I", data, gen + 44)),
        "name": string(uint(gen + 40)),
        "window_width": uint(gen + 60),
        "window_height": uint(gen + 64),
        "info_flags": uint(gen + 68),
        "steam_app_id_field": struct.unpack_from("<i", data, gen + 120)[0],
    }
    counts = {}
    for name in ("EXTN", "SOND", "AGRP", "SPRT", "BGND", "PATH", "SCPT", "GLOB",
                 "SHDR", "FONT", "TMLN", "OBJT", "ROOM", "TPAG", "CODE", "STRG", "TXTR", "AUDO"):
        counts[name] = len(pointers(name))

    scripts = {string(uint(pointer)) for pointer in pointers("SCPT")}
    code = []
    for pointer in pointers("CODE"):
        bounds(pointer, 20)
        address = pointer + 12 + struct.unpack_from("<i", data, pointer + 12)[0]
        length = uint(pointer + 4)
        bounds(address, length)
        code.append({"name": string(uint(pointer)), "offset": address, "length": length})
    code.sort(key=lambda item: item["offset"])
    starts = [item["offset"] for item in code]

    def owner(address):
        index = bisect.bisect_right(starts, address) - 1
        if index < 0 or address >= code[index]["offset"] + code[index]["length"]:
            raise ValueError(f"Function reference outside bytecode: {address:#x}")
        return code[index]["name"]

    functions = []
    start = chunk("FUNC")
    count = uint(start)
    if 4 + 12 * count > chunks["FUNC"]["size"]:
        raise ValueError("Invalid FUNC table")
    for index in range(count):
        entry = start + 4 + 12 * index
        name = string(uint(entry))
        occurrences = uint(entry + 4)
        address = uint(entry + 8)
        callers = set()
        visited = set()
        for occurrence in range(occurrences):
            bounds(address, 8)
            if address in visited:
                raise ValueError(f"Cyclic FUNC references for {name}")
            visited.add(address)
            callers.add(owner(address))
            if occurrence + 1 < occurrences:
                address += uint(address + 4) & 0xFFFFFF
        functions.append({"name": name, "kind": "script" if name in scripts else "builtin",
                          "occurrences": occurrences, "callers": sorted(callers)})

    room_metadata = []
    for index, pointer in enumerate(pointers("ROOM")):
        bounds(pointer, 24)
        room_metadata.append({"index": index, "name": string(uint(pointer)),
                              "width": uint(pointer + 8), "height": uint(pointer + 12),
                              "speed": uint(pointer + 16)})
    save_names = {"file0", "file8", "file9", "undertale.ini",
                  "system_information_962", "system_information_963"}
    observed_save_names = sorted(save_names.intersection(
        string(pointer + 4) for pointer in pointers("STRG")))
    return {
        "source": {"path": str(path.resolve()), "bytes": len(data),
                   "sha256": hashlib.sha256(data).hexdigest()},
        "general": info, "chunks": chunks, "counts": counts,
        "functions": functions, "rooms": room_metadata,
        "save_filename_literals": observed_save_names,
        "limitations": [
            "Metadata and static FUNC reference chains only; no control-flow or execution proof.",
            "Runtime version field can differ from the actual compiler release.",
            "A recorded builtin reference does not prove the runtime path executes.",
            "Save filename literals do not establish when or where files are written.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_directory", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".private/reports/game-inventory.json"))
    args = parser.parse_args()
    source = args.game_directory.resolve()
    output = args.output.resolve()
    if output == source or source in output.parents:
        parser.error("Keep the report outside the installed game directory")
    try:
        report = inspect(source / "data.win")
        report["installed_files"] = [{"name": item.name, "bytes": item.stat().st_size,
                                     "sha256": sha256(item)}
                                    for item in sorted(source.iterdir()) if item.is_file()]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, struct.error) as error:
        parser.exit(1, f"Inspection failed: {error}\n")
    print(f"Wrote metadata report: {output}")
    print(f"data.win SHA-256: {report['source']['sha256']}")
    print(f"WAD v{report['general']['bytecode_version']}; "
          f"{report['counts']['ROOM']} rooms; {len(report['functions'])} function records")


if __name__ == "__main__":
    main()
