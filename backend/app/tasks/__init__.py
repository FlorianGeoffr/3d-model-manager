"""Celery worker package (SPEC "Processing pipeline", Task 6).

``app.tasks.base`` is the worker's SYNC world (its own SQLAlchemy engine);
``app.tasks.celery_app`` builds the ``Celery`` application; ``app.tasks.ingest``
holds the actual task bodies. See each module's docstring.
"""
