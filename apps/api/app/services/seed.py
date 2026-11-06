from app.services.utils.criteo_generator import build_demo_rows


def ensure_demo_if_empty() -> None:
    # Lazy import breaks analytics <-> data_store cycle via seed.
    from app.services.data_store import ensure_seed_data

    ensure_seed_data(build_demo_rows(3000))
