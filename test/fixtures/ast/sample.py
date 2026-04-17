def top_level(x):
    return x * 2


class Greeter:
    def __init__(self, name):
        self.name = name

    def hello(self):
        return f"hi {self.name}"


@staticmethod
def decorated_free():
    return 42
