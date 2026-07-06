"""Pure parsing/loading helpers for the processing pipeline's steps (Tasks
3-6): no Celery, no DB, no storage backend -- just format-specific code
called by ``app.tasks.pipeline``'s step functions.
"""
