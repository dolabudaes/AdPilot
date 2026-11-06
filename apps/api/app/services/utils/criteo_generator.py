import random

CAMPAIGNS = ["Campaign A", "Campaign B", "Campaign C", "Campaign D", "Campaign E"]


def build_demo_rows(rows: int = 2600) -> list[dict]:
    now = __import__("time").time() * 1000
    data = []
    for i in range(rows):
        campaign = random.choice(CAMPAIGNS)
        impression_time = __import__("datetime").datetime.utcfromtimestamp(now / 1000 - i * 3600).isoformat() + "Z"
        click = 1 if random.random() < 0.18 else 0
        conversion = 1 if click and random.random() < 0.12 else 0
        attributed = 1 if conversion and random.random() < 0.7 else 0
        data.append(
            {
                "timestamp": impression_time,
                "uid": f"uid-{i // 3}",
                "campaign": campaign,
                "conversion": conversion,
                "conversion_timestamp": impression_time if conversion else None,
                "conversion_id": f"conv-{i}" if conversion else None,
                "attribution": attributed,
                "click": click,
                "click_pos": max(1, int(random.random() * 4)) if click else None,
                "click_nb": max(1, int(random.random() * 3)) if click else None,
                "cost": round(random.uniform(0.15, 3.8), 4),
                "cpo": round(random.uniform(15, 45), 2) if attributed else 0,
                "time_since_last_click": random.uniform(1, 2000) if click else None,
                **{f"cat{j}": f"c{j}-{int(random.random() * 8) + 1}" for j in range(1, 10)},
            }
        )
    return data
