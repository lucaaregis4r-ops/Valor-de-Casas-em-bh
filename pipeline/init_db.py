from .database import PostgresDatabase


def main() -> None:
    with PostgresDatabase.from_env() as database:
        database.initialize_schema()
    print("Esquema PostgreSQL aplicado.")


if __name__ == "__main__":
    main()

