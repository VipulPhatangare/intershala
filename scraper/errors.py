"""Exceptions shared across the scraper."""


class ScraperError(Exception):
    """Base class for scraper failures."""


class AuthExpired(ScraperError):
    """The saved session is no longer valid and a manual login is required."""


class NoSession(ScraperError):
    """No session file exists yet, and this run is not allowed to prompt for login."""
