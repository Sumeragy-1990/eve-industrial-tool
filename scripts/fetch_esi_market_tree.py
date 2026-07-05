#!/usr/bin/env python3
"""
Fetch the complete EVE Online market group hierarchy from the ESI API
and generate a static Python file with item names and tree structure.

This is the authoritative source of truth - CCP's official ESI API.
"""
import asyncio
import aiohttp
import json
import sys
import os

ESI_BASE = "https://esi.evetech.net/latest"
ESI_GROUPS_URL = f"{ESI_BASE}/markets/groups/?datasource=tranquility"
ESI_GROUP_URL = f"{ESI_BASE}/markets/groups/{{group_id}}/?datasource=tranquility"
ESI_NAMES_URL = f"{ESI_BASE}/universe/names/?datasource=tranquility"

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", "app", "data")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "esi_market_tree.py")

# Rate limiting
SEMAPHORE = asyncio.Semaphore(10)  # Max 10 concurrent requests

async def fetch_json(session, url, retries=3, method="GET", json_data=None):
    """Fetch JSON from ESI API with retry logic."""
    for attempt in range(retries):
        try:
            async with SEMAPHORE:
                if method == "POST":
                    async with session.post(url, json=json_data, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        elif resp.status == 429:
                            wait = int(resp.headers.get("Retry-After", "5"))
                            print(f"  ⚠ Rate limited, waiting {wait}s...")
                            await asyncio.sleep(wait)
                            continue
                        else:
                            print(f"  ❌ HTTP {resp.status} for {url}")
                            return None
                else:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        if resp.status == 200:
                            return await resp.json()
                        elif resp.status == 429:
                            wait = int(resp.headers.get("Retry-After", "5"))
                            print(f"  ⚠ Rate limited, waiting {wait}s...")
                            await asyncio.sleep(wait)
                            continue
                        else:
                            print(f"  ❌ HTTP {resp.status} for {url}")
                            return None
        except Exception as e:
            print(f"  ❌ Error: {e} (attempt {attempt+1}/{retries})")
            await asyncio.sleep(2 ** attempt)
    return None

async def fetch_market_group(session, group_id: int) -> dict | None:
    """Fetch a single market group by ID."""
    url = ESI_GROUP_URL.format(group_id=group_id)
    data = await fetch_json(session, url)
    if data:
        return {
            "id": group_id,
            "name": data.get("name", f"Unknown-{group_id}"),
            "parent_group_id": data.get("parent_group_id"),
            "types": data.get("types", []),
        }
    return None

async def resolve_names(session, type_ids: list[int]) -> dict[int, str]:
    """Resolve type IDs to names using ESI /universe/names/."""
    result = {}
    # Split into batches of 1000 (ESI max)
    for i in range(0, len(type_ids), 1000):
        batch = type_ids[i:i+1000]
        if not batch:
            continue
        data = await fetch_json(session, ESI_NAMES_URL, method="POST", json_data=batch)
        if data:
            for entry in data:
                if entry.get("category") in ("inventory_type", "blueprint", "skill", "implant"):
                    result[entry["id"]] = entry.get("name", f"Unknown-{entry['id']}")
    return result

def build_tree(groups: list[dict]) -> list[dict]:
    """Build hierarchical tree from flat group list."""
    # Index by ID
    by_id = {g["id"]: g for g in groups}
    
    # Build children lists
    for g in groups:
        g["children"] = []
    for g in groups:
        pid = g["parent_group_id"]
        if pid is not None and pid in by_id:
            by_id[pid]["children"].append(g)
    
    # Sort children by name
    def sort_children(children):
        children.sort(key=lambda x: x["name"])
        for child in children:
            sort_children(child["children"])
    
    # Get root nodes (parent_group_id is None)
    roots = [g for g in groups if g["parent_group_id"] is None]
    roots.sort(key=lambda x: x["name"])
    for root in roots:
        sort_children(root["children"])
    
    return roots

def format_python_value(val, indent=0):
    """Format a value as Python code."""
    sp = "    "
    if isinstance(val, str):
        escaped = val.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        return f"'{escaped}'"
    elif isinstance(val, bool):
        return "True" if val else "False"
    elif isinstance(val, int):
        return str(val)
    elif val is None:
        return "None"
    elif isinstance(val, list):
        if not val:
            return "[]"
        items = []
        for item in val:
            items.append(format_python_value(item, indent + 1))
        # Compact for short lists, multi-line for long
        if len(val) <= 3 and all(len(l) < 40 for l in items):
            return "[" + ", ".join(items) + "]"
        else:
            inner = ",\n" + sp * (indent + 1)
            return "[\n" + sp * (indent + 1) + (",\n" + sp * (indent + 1)).join(items) + ",\n" + sp * indent + "]"
    elif isinstance(val, dict):
        if not val:
            return "{}"
        items = []
        for k, v in val.items():
            k_str = format_python_value(k, indent + 1)
            v_str = format_python_value(v, indent + 1)
            items.append(f"{k_str}: {v_str}")
        inner = ",\n" + sp * (indent + 1)
        return "{\n" + sp * (indent + 1) + (",\n" + sp * (indent + 1)).join(items) + ",\n" + sp * indent + "}"
    return str(val)

def generate_static_tree(roots: list[dict], name_map: dict[int, str]) -> str:
    """Generate the static Python tree file content."""
    lines = []
    lines.append('"""')
    lines.append('Static EVE Online Market Tree – generated from ESI API.')
    lines.append('')
    lines.append('This is the authoritative source of truth for the market group hierarchy.')
    lines.append('Generated from CCP\'s ESI API (https://esi.evetech.net/).')
    lines.append('')
    lines.append('Structure:')
    lines.append('  [')
    lines.append('    {')
    lines.append('      "name": str,            # Market group name')
    lines.append('      "esi_id": int,          # ESI market group ID')
    lines.append('      "items": [str],          # Item names in this group (leaf groups only)')
    lines.append('      "children": [...],       # Sub-groups (non-leaf groups)')
    lines.append('      "has_blueprints": bool,  # Whether items here have manufacturable BPs')
    lines.append('    },')
    lines.append('    ...')
    lines.append('  ]')
    lines.append('"""')
    lines.append('')
    lines.append('# ruff: noqa: E501')
    lines.append('')
    
    # Build item-name lookup for comments
    name_lookup = {v: k for k, v in name_map.items()}
    
    def esc(val):
        """Escape a string value for safe insertion in a single-quoted Python string."""
        if isinstance(val, str):
            escaped = val.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
            return escaped
        return str(val)

    def format_node(node, indent=1):
        sp = "    "
        lines.append(sp * indent + "{")
        lines.append(sp * (indent + 1) + f"# ESI Group ID: {node['id']}")
        lines.append(sp * (indent + 1) + f"'name': '{esc(node['name'])}',")
        lines.append(sp * (indent + 1) + f"'esi_id': {node['id']},")
        
        if node["children"]:
            # Non-leaf: has children
            lines.append(sp * (indent + 1) + "'children': [")
            for child in node["children"]:
                format_node(child, indent + 2)
            lines.append(sp * (indent + 1) + "],")
            lines.append(sp * (indent + 1) + "'items': None,")
        else:
            # Leaf: has items (type names)
            type_ids = node.get("types", [])
            item_names = []
            for tid in type_ids:
                name = name_map.get(tid)
                if name:
                    item_names.append(name)
            item_names.sort()
            
            if item_names:
                lines.append(sp * (indent + 1) + "'children': None,")
                lines.append(sp * (indent + 1) + "'items': [")
                for iname in item_names:
                    escaped_name = esc(iname)
                    lines.append(sp * (indent + 2) + f"'{escaped_name}',  # type_id={name_lookup.get(iname, '?')}")
                lines.append(sp * (indent + 1) + "],")
            else:
                lines.append(sp * (indent + 1) + "'children': None,")
                lines.append(sp * (indent + 1) + "'items': [],")
        
        lines.append(sp * (indent + 1) + "'has_blueprints': True,")
        lines.append(sp * indent + "},")
    
    # Add MARKET_TREE = [ before the root nodes
    lines.append("MARKET_TREE = [")
    for root in roots:
        format_node(root, 1)
    lines.append("]")
    
    return "\n".join(lines)

async def main():
    print("=" * 60)
    print("EVE Online ESI Market Tree Generator")
    print("=" * 60)
    
    # Create output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    connector = aiohttp.TCPConnector(limit=20)
    async with aiohttp.ClientSession(connector=connector) as session:
        # Step 1: Get all market group IDs
        print("\n📡 Step 1: Fetching all market group IDs...")
        group_ids = await fetch_json(session, ESI_GROUPS_URL)
        if not group_ids:
            print("❌ Failed to fetch market group list!")
            return
        print(f"   ✓ Found {len(group_ids)} market groups")
        
        # Step 2: Fetch details for each group
        print(f"\n📡 Step 2: Fetching details for {len(group_ids)} groups...")
        tasks = [fetch_market_group(session, gid) for gid in group_ids]
        results = await asyncio.gather(*tasks)
        groups = [g for g in results if g is not None]
        print(f"   ✓ Fetched {len(groups)}/{len(group_ids)} groups successfully")
        
        # Step 3: Collect all unique type IDs
        print(f"\n📡 Step 3: Collecting all type IDs...")
        all_type_ids = set()
        for g in groups:
            all_type_ids.update(g["types"])
        print(f"   ✓ {len(all_type_ids)} unique type IDs across all groups")
        
        # Step 4: Resolve type IDs to names
        print(f"\n📡 Step 4: Resolving {len(all_type_ids)} type IDs to names...")
        type_id_list = sorted(all_type_ids)
        name_map = await resolve_names(session, type_id_list)
        print(f"   ✓ Resolved {len(name_map)}/{len(all_type_ids)} names")
        
        # Step 5: Build tree hierarchy
        print(f"\n🌳 Step 5: Building tree hierarchy...")
        roots = build_tree(groups)
        print(f"   ✓ Tree has {len(roots)} root categories")
        
        def count_nodes(nodes):
            count = len(nodes)
            for n in nodes:
                count += count_nodes(n.get("children", []))
            return count
        
        def count_leaves(nodes):
            count = 0
            for n in nodes:
                if n.get("children"):
                    count += count_leaves(n["children"])
                else:
                    count += 1
            return count
        
        print(f"      Total groups: {count_nodes(roots)}")
        print(f"      Leaf groups: {count_leaves(roots)}")
        
        # Step 6: Generate static file
        print(f"\n📝 Step 6: Generating static Python file...")
        content = generate_static_tree(roots, name_map)
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            f.write(content)
        file_size = os.path.getsize(OUTPUT_FILE)
        print(f"   ✓ Written to {OUTPUT_FILE}")
        print(f"      Size: {file_size:,} bytes ({file_size/1024:.1f} KB)")
        
        # Step 7: Generate summary
        print(f"\n📊 Step 7: Summary...")
        
        # Get all item names for blueprint check
        all_items_with_bp = set()
        # We can also check which items have blueprints by querying our DB later
        # For now we just report the market structure
        
        for root in roots:
            def count_items(nodes):
                count = 0
                for n in nodes:
                    if n.get("items"):
                        count += len(n["items"])
                    if n.get("children"):
                        count += count_items(n["children"])
                return count
            item_count = count_items([root])
            node_count = count_nodes([root])
            print(f"   • {root['name']}: {node_count} groups, {item_count} items")
        
        print(f"\n✅ Done! Static market tree saved to: {OUTPUT_FILE}")
        print(f"   Next: Run the resolver to match these items with blueprint data.")

if __name__ == "__main__":
    asyncio.run(main())
