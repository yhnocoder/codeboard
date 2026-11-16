class Base:
    def forward(self, x):
        """Run it."""
        raise NotImplementedError

    @abstractmethod
    def other(self):
        return 1

    def real(self, x):
        return x + 1

    def dots(self): ...
