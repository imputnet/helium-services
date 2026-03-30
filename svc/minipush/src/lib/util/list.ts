class Node<T> {
    value: T;
    prev?: Node<T>;
    next?: Node<T>;

    constructor(value: T) {
        this.value = value;
    }
}

export class List<T> {
    #head?: Node<T>;
    #tail?: Node<T>;

    push(value: T) {
        const node = new Node(value);
        node.prev = this.#tail;

        if (this.#tail) {
            this.#tail.next = node;
        } else {
            this.#head = node;
        }

        this.#tail = node;
    }

    delete(node: Node<T>) {
        const [prev, next] = [node.prev, node.next];

        if (prev) prev.next = next;
        if (next) next.prev = prev;

        if (node === this.#head) {
            this.#head = next;
        }

        if (node === this.#tail) {
            this.#tail = prev;
        }

        node.prev = undefined;
        node.next = undefined;
    }

    *[Symbol.iterator]() {
        let node = this.#head;
        while (node) {
            yield node;
            node = node.next;
        }
    }
}
