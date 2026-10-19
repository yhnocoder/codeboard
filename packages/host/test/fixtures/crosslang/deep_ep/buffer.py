class Buffer:
    def __init__(self, group):
        self.runtime = deep_ep_cpp.Buffer(group)

    def dispatch(self, x, num_ranks):
        recv_x = self.runtime.intranode_dispatch(x, num_ranks)
        return recv_x

    def launch(self, x):
        return self.runtime.jit_dispatch(x)
